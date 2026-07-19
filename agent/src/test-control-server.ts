// Security regression tests for the control server — the fleet-audit auth/CSRF/body-cap/mutex/rate-limit
// hardening. Drives the REAL server over a real loopback socket; the ritual spawner is stubbed so no
// actual ritual runs. Run: npm run test:control-server
// Invariants under test:
//   - state-changing POSTs require the x-control-token header (constant-time); read-only GETs stay open;
//   - a cross-site Origin is refused (CSRF backstop) and a header-less "simple" cross-site POST is rejected;
//   - an over-cap request body → 413; a normal small body still works;
//   - /api/run runs one-at-a-time (2nd concurrent → 409) and is rate-limited (excess → 429);
//   - GET / serves the panel WITHOUT leaking the token (operator passes it out-of-band via the #fragment);
//     a caller holding the token can still drive every state-changing endpoint.
import { createServer, request as httpRequest } from "node:http";
import { once, EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── pick a free port, then configure the server via env BEFORE importing it ──
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const p = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

// Save MODE/PROFILE so a state-changing test can't clobber the repo files.
const MODE_FILE = fileURLToPath(new URL("../MODE", import.meta.url));
const PROFILE_FILE = fileURLToPath(new URL("../PROFILE", import.meta.url));
const savedMode = (() => { try { return readFileSync(MODE_FILE, "utf8"); } catch { return null; } })();
const savedProfile = (() => { try { return readFileSync(PROFILE_FILE, "utf8"); } catch { return null; } })();

const PORT = await freePort();
const TOKEN = "test-token-abc-1234567890";
process.env.BILL_CONTROL_PORT = String(PORT);
process.env.BILL_CONTROL_TOKEN = TOKEN;
process.env.BILL_CONTROL_BODY_CAP = "100";     // tiny cap so an oversize body is easy to trigger
process.env.BILL_RUN_RATE_MAX = "3";           // mutex test uses 1 slot, rate test uses 2 more then 429
process.env.BILL_RUN_RATE_WINDOW_MS = "60000";

const mod = await import("./control-server.js");
if (!mod.server.listening) await once(mod.server, "listening");
const base = `http://127.0.0.1:${PORT}`;

// ── stub the ritual spawner so /api/run never launches a real ritual ──
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() { return true; }
  finishClose(code = 0) { this.emit("close", code); }
}
let autoClose = true;
const children: FakeChild[] = [];
mod.__setSpawner(((): ChildProcessWithoutNullStreams => {
  const c = new FakeChild();
  children.push(c);
  if (autoClose) setImmediate(() => c.finishClose(0));
  return c as unknown as ChildProcessWithoutNullStreams;
}));

interface Res { status: number; text: string; json: any }
// Raw http.request (not fetch): fetch/undici strips forbidden request headers like Origin, which would
// make the CSRF assertions vacuous. http.request sends exactly the headers we specify.
function req(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(base + path, { method, headers: opts.headers || {} }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { let json: any; try { json = JSON.parse(text); } catch { /* non-JSON (HTML page) */ } resolve({ status: res.statusCode || 0, text, json }); });
    });
    r.on("error", reject);
    if (opts.body != null) r.write(opts.body);
    r.end();
  });
}
const AUTH = { "x-control-token": TOKEN, "content-type": "application/json" };

try {
  check("exported CONTROL_TOKEN matches the env token", mod.CONTROL_TOKEN === TOKEN);

  // ── READ-ONLY endpoints stay open (no token) ──
  const health = await req("GET", "/health");
  check("GET /health open, 200, ok:true", health.status === 200 && health.json?.ok === true && health.json?.service === "bill-control");
  const state = await req("GET", "/api/state");
  check("GET /api/state open, 200, has mode", state.status === 200 && typeof state.json?.mode === "string");
  const page = await req("GET", "/");
  check("GET / serves the HTML panel (200)", page.status === 200 && page.text.includes("Bill the Bull"));
  check("GET / does NOT leak the control token in the unauthenticated body (Codex round-2)",
    !page.text.includes(TOKEN) && !page.text.includes("__BILL_TOKEN__"));

  // ── ITEM 2: auth on state-changing endpoints ──
  const noTok = await req("POST", "/api/mode", { headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "gated" }) });
  check("POST /api/mode WITHOUT token → 401", noTok.status === 401);
  const badTok = await req("POST", "/api/mode", { headers: { "content-type": "application/json", "x-control-token": "wrong" }, body: JSON.stringify({ mode: "gated" }) });
  check("POST /api/mode with WRONG token → 401", badTok.status === 401);
  const okTok = await req("POST", "/api/mode", { headers: AUTH, body: JSON.stringify({ mode: "gated" }) });
  check("POST /api/mode WITH token → 200 and mode applied", okTok.status === 200 && okTok.json?.ok === true && okTok.json?.mode === "gated");
  const noTokProfile = await req("POST", "/api/profile", { headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "steady" }) });
  check("POST /api/profile WITHOUT token → 401", noTokProfile.status === 401);

  // ── ITEM 3: CSRF — cross-site Origin refused; header-less cross-site POST rejected ──
  const evilOrigin = await req("POST", "/api/mode", { headers: { ...AUTH, origin: "https://evil.example" }, body: JSON.stringify({ mode: "off" }) });
  check("POST /api/mode with cross-site Origin (even w/ token) → 403", evilOrigin.status === 403);
  const csrfForm = await req("POST", "/api/mode", { headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: "mode=auto" });
  check("simple cross-site POST without the custom header → rejected (not 200)", csrfForm.status === 403 || csrfForm.status === 401);

  // ── ITEM 4: request body size cap ──
  const bigBody = JSON.stringify({ mode: "gated", pad: "x".repeat(500) }); // > 100-byte cap
  const oversize = await req("POST", "/api/mode", { headers: AUTH, body: bigBody });
  check("oversize body → 413", oversize.status === 413);
  const smallOk = await req("POST", "/api/mode", { headers: AUTH, body: JSON.stringify({ mode: "gated" }) });
  check("small body under cap → 200", smallOk.status === 200);

  // ── ITEM 5a: mutex — a 2nd concurrent /api/run is refused while one is in flight ──
  autoClose = false;
  const pRun = req("POST", "/api/run?ritual=refresh", { headers: { "x-control-token": TOKEN } }); // stays in flight
  await delay(60); // let the server acquire the mutex + spawn the (stubbed) child
  const concurrent = await req("POST", "/api/run?ritual=refresh", { headers: { "x-control-token": TOKEN } });
  check("2nd concurrent /api/run while one in flight → 409", concurrent.status === 409);
  children[children.length - 1]?.finishClose(0); // let the in-flight run complete → releases the mutex
  const firstRun = await pRun;
  check("the in-flight /api/run then completes → 200", firstRun.status === 200 && firstRun.json?.ritual === "refresh");

  // ── ITEM 5b: rate limit — with MAX=3 (1 slot already used above), 2 more pass then the next is 429 ──
  autoClose = true;
  const rl2 = await req("POST", "/api/run?ritual=refresh", { headers: { "x-control-token": TOKEN } }); // slot 2
  const rl3 = await req("POST", "/api/run?ritual=refresh", { headers: { "x-control-token": TOKEN } }); // slot 3
  const rl4 = await req("POST", "/api/run?ritual=refresh", { headers: { "x-control-token": TOKEN } }); // over the cap
  check("runs within the window succeed (slots 2 & 3)", rl2.status === 200 && rl3.status === 200);
  check("run past the rate cap → 429", rl4.status === 429);

  // ── /api/run also still validates the ritual name (unknown → 400), auth applies ──
  const badRitual = await req("POST", "/api/run?ritual=hack", { headers: { "x-control-token": TOKEN } });
  check("unknown ritual (authed) → 400", badRitual.status === 400);
  const runNoTok = await req("POST", "/api/run?ritual=refresh", {});
  check("POST /api/run WITHOUT token → 401", runNoTok.status === 401);
} finally {
  try { if (savedMode !== null) writeFileSync(MODE_FILE, savedMode); } catch { /* best effort restore */ }
  try { if (savedProfile !== null) writeFileSync(PROFILE_FILE, savedProfile); } catch { /* best effort restore */ }
  await new Promise<void>((resolve) => mod.server.close(() => resolve()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
