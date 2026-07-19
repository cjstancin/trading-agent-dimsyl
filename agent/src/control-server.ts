// Local control panel for "Bill the Bull" — flips the bot's MODE (off | gated | auto) that the rituals
// read from the MODE file, and runs a ritual on demand. LOCAL ONLY: binds 127.0.0.1 so a public page can
// never drive a live trading bot. The public dashboard only *displays* the mode (read-only).
//   npm run control   →   http://localhost:4317
//
// AUTH (fleet-audit hardening): the state-changing endpoints (/api/mode, /api/profile, /api/run) require a
// custom `x-control-token` header (constant-time compared) AND a same-origin Origin, which together close
// (a) any other local process poking the panel and (b) CSRF from a malicious page in CJ's browser — a
// cross-site form/fetch cannot set a custom header. Read-only GETs (/, /api/state, /health) stay open.
// The token comes from BILL_CONTROL_TOKEN; if unset a random one is minted per boot and injected into the
// served page so the browser UI keeps working with zero config. The scheduled rituals do NOT use this HTTP
// surface (systemd → run-*.sh → `npm run <ritual>` directly), so auth here breaks nothing on the box.
import "./load-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { getMode, setMode, autoExecAllowed, MODES, type Mode } from "./mode.js";
import { getProfile, setProfile, PROFILES, type Profile } from "./profile.js";
import { installSafetyNet, timingSafeTokenMatch } from "./http-utils.js";

const SERVICE = "bill-control";
const START_MS = Date.now();
installSafetyNet(SERVICE);

const PORT = Number(process.env.BILL_CONTROL_PORT || 4317);
const PAGE = fileURLToPath(new URL("./control-page.html", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const RITUALS = new Set(["premarket", "execute", "refresh"]);
// Cap any single ritual run — a hung Claude SDK call must not pin the HTTP socket or accumulate zombie
// children if CJ clicks "Run" multiple times. 5 min covers a full premarket cycle with margin.
const RITUAL_TIMEOUT_MS = Number(process.env.BILL_RITUAL_TIMEOUT_MS || 5 * 60_000);

// ── AUTH / CSRF config ──────────────────────────────────────────────────────────────────────────────
// BILL_CONTROL_TOKEN gates every state-changing request. Unset → mint an ephemeral per-boot token so the
// served UI still works (token is injected into the page) while external/CSRF callers are locked out.
const ENV_TOKEN = (process.env.BILL_CONTROL_TOKEN || "").trim();
const CONTROL_TOKEN = ENV_TOKEN || randomBytes(32).toString("hex");
const TOKEN_FROM_ENV = ENV_TOKEN.length > 0;
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
// Control payloads are tiny ({"mode":"gated"}); cap the body hard so a large POST can't be buffered (DoS).
const BODY_CAP = Number(process.env.BILL_CONTROL_BODY_CAP) || 64 * 1024;
// /api/run guards: one ritual at a time (mutex) + a per-window ceiling (repeated posts = unbounded LLM spend).
const RUN_RATE_MAX = Number(process.env.BILL_RUN_RATE_MAX) || 12;
const RUN_RATE_WINDOW_MS = Number(process.env.BILL_RUN_RATE_WINDOW_MS) || 60_000;
let ritualRunning = false;
const runTimestamps: number[] = [];

// The ritual runner is a seam so the endpoint-guard tests can drive /api/run without launching a real
// ritual. Production ALWAYS uses defaultSpawner (`npm run <ritual>`); this changes nothing a ritual does.
type Spawner = (ritual: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const defaultSpawner: Spawner = (ritual, env) => spawn("npm", ["run", ritual], { cwd: AGENT_DIR, shell: true, env });
let spawnRitual: Spawner = defaultSpawner;
export function __setSpawner(fn: Spawner | null): void { spawnRitual = fn ?? defaultSpawner; }

const sendJson = (res: ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

const headerStr = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

/** Same-origin? A missing Origin (curl / non-browser) is allowed through to the token gate; a *present*
 *  cross-site Origin is rejected outright. Browsers set Origin automatically on cross-site POSTs, so this
 *  is a cheap extra CSRF backstop on top of the custom-header token requirement. */
const originOk = (req: IncomingMessage): boolean => {
  const o = headerStr(req.headers.origin);
  return !o || ALLOWED_ORIGINS.has(o);
};

/** Constant-time token check on the custom `x-control-token` header. A cross-site browser request cannot
 *  set a custom header without a CORS preflight (which this server never approves), so this closes CSRF. */
const authOk = (req: IncomingMessage): boolean =>
  timingSafeTokenMatch(headerStr(req.headers["x-control-token"]), CONTROL_TOKEN);

/** Gate a state-changing request: rejects a cross-site Origin (403) or a missing/bad token (401).
 *  Returns true only when the caller may proceed. */
const guardStateChange = (req: IncomingMessage, res: ServerResponse): boolean => {
  if (!originOk(req)) { sendJson(res, 403, { ok: false, error: "forbidden origin" }); return false; }
  if (!authOk(req)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return false; }
  return true;
};

/** Drain a request body bounded to BODY_CAP so a large POST can never be buffered into memory (DoS). Stops
 *  accumulating past the cap and answers a clean 413 on end (deliberately does NOT destroy the socket —
 *  that would race the 413 write and, via installSafetyNet, crash the process). Node's own request timeout
 *  bounds a client that streams forever. Returns null after it has already answered (caller just returns). */
const readJsonBody = (req: IncomingMessage, res: ServerResponse): Promise<string | null> =>
  new Promise((resolve) => {
    let buf = "";
    let over = false;
    req.on("data", (d) => { if (over) return; buf += d; if (buf.length > BODY_CAP) over = true; });
    req.on("end", () => {
      if (over) { sendJson(res, 413, { ok: false, error: "request body too large" }); resolve(null); }
      else resolve(buf);
    });
    req.on("error", () => { try { sendJson(res, 400, { ok: false, error: "bad request body" }); } catch { /* socket gone */ } resolve(null); });
  });

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // Inject the current control token so the same-origin UI can authenticate its POSTs. `<` is escaped
      // so a token value can never break out of the <script> element.
      const tokenLiteral = JSON.stringify(CONTROL_TOKEN).replace(/</g, "\\u003c");
      res.end(readFileSync(PAGE, "utf8").replace("</head>", `<script>window.__BILL_TOKEN__=${tokenLiteral};</script></head>`));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, { mode: getMode(), autoExec: autoExecAllowed(), profile: getProfile() });
    }
    // Fleet-standard health probe (same contract as SAMS /health, Atlas /health). Includes mode +
    // profile so a monitor can see Bill's current trading posture at a glance.
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: SERVICE, uptimeSec: Math.round((Date.now() - START_MS) / 1000), mode: getMode(), profile: getProfile() });
    }
    if (req.method === "POST" && url.pathname === "/api/profile") {
      if (!guardStateChange(req, res)) return;
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const p = String((JSON.parse(body || "{}").profile ?? "")).toLowerCase();
      if (!(PROFILES as string[]).includes(p)) return sendJson(res, 400, { ok: false, error: `bad profile "${p}"` });
      setProfile(p as Profile);
      return sendJson(res, 200, { ok: true, profile: getProfile() });
    }
    if (req.method === "POST" && url.pathname === "/api/mode") {
      if (!guardStateChange(req, res)) return;
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const m = String((JSON.parse(body || "{}").mode ?? "")).toLowerCase();
      if (!(MODES as string[]).includes(m)) return sendJson(res, 400, { ok: false, error: `bad mode "${m}"` });
      setMode(m as Mode);
      return sendJson(res, 200, { ok: true, mode: getMode(), autoExec: autoExecAllowed() });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      if (!guardStateChange(req, res)) return;
      const ritual = url.searchParams.get("ritual") || "premarket";
      const dry = url.searchParams.get("dry") === "1";
      if (!RITUALS.has(ritual)) return sendJson(res, 400, { ok: false, error: "unknown ritual" });
      // Rate limit: drop stale entries, then refuse once the window is full (guards unbounded LLM spend).
      const now = Date.now();
      while (runTimestamps.length && now - runTimestamps[0] > RUN_RATE_WINDOW_MS) runTimestamps.shift();
      if (runTimestamps.length >= RUN_RATE_MAX) return sendJson(res, 429, { ok: false, error: "rate limited — too many runs, slow down" });
      // Mutex: exactly one ritual at a time — a 2nd concurrent /api/run is refused, never overlapped.
      // (This guards the ENDPOINT only; it does not change what a ritual does when it runs.)
      if (ritualRunning) return sendJson(res, 409, { ok: false, error: "a ritual is already running" });
      ritualRunning = true;
      runTimestamps.push(now);
      const env = dry ? { ...process.env, BILL_DRY_RUN: "1" } : process.env;
      let out = "";
      let settled = false;
      const finish = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        ritualRunning = false; // release the mutex on every exit path (close/error/timeout)
        sendJson(res, 200, payload);
      };
      let child;
      try {
        child = spawnRitual(ritual, env);
      } catch (e) {
        finish({ ok: false, ritual, code: null, error: String(e instanceof Error ? e.message : e) });
        return;
      }
      // Hard cap so a stuck ritual can't hold the response open or leave a zombie. SIGTERM, then SIGKILL.
      const killTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5_000).unref();
        finish({ ok: false, ritual, code: null, timedOut: true, tail: out.slice(-1600) });
      }, RITUAL_TIMEOUT_MS);
      killTimer.unref();
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => { clearTimeout(killTimer); finish({ ok: false, ritual, code: null, error: String(e?.message || e), tail: out.slice(-1600) }); });
      child.on("close", (code) => { clearTimeout(killTimer); finish({ ok: code === 0, ritual, code, tail: out.slice(-1600) }); });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  🐂  Bill the Bull — control panel`);
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  mode: ${getMode()}  ·  auto-exec armed: ${autoExecAllowed()}`);
  console.log(`  auth: ${TOKEN_FROM_ENV ? "BILL_CONTROL_TOKEN (env)" : "ephemeral per-boot token (set BILL_CONTROL_TOKEN to make it stable)"}\n`);
});

// Exported for the regression test (no listen) — lets it drive the server against a real socket.
export { server, CONTROL_TOKEN, PORT };
