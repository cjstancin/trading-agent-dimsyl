// SUCCESS / FAIL / NULL tests for the SAMS heartbeat (no network — global.fetch is stubbed, same
// pattern as test-fleet-emit). Run: npm run test:sams-report
// Invariants under test — the fleet-audit #1 REGRESSION lives here:
//   - samsReport SENDS x-sams-control-token when SAMS_CONTROL_TOKEN is set (it used to post
//     token-less while fleet-emit carried the token → the hardened conductor would refuse the
//     heartbeat and Bill would silently read OFFLINE mid-session);
//   - backward-compatible: no token → still posts, WITHOUT the header (conductor legacy path);
//   - unreachable/non-2xx conductor → {ok:false} result, NEVER a throw.
import { samsReport } from "./sams-report.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

const realFetch = globalThis.fetch;
interface Captured { url: string; method?: string; headers: Record<string, string>; body: unknown }
let captured: Captured[] = [];
const stubFetch = (status = 200) => {
  captured = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "null")) });
    return new Response("{}", { status });
  }) as typeof fetch;
};

// ── SUCCESS: token in env → header carried (fleet-audit fix #1) ──
process.env.SAMS_CONTROL_TOKEN = "tok-bull";
stubFetch();
{
  const r = await samsReport("bull", { status: "ok", loadScore: 0.2 }, { url: "https://castle.example/" });
  const req = captured[0];
  check("SUCCESS: ok result on 2xx", r.ok === true && r.status === 200);
  check("SUCCESS: POST → <url>/report", req.url === "https://castle.example/report" && req.method === "POST");
  check("SUCCESS: x-sams-control-token header carried", req.headers["x-sams-control-token"] === "tok-bull");
  const b = req.body as Record<string, unknown>;
  check("SUCCESS: body carries {id:'bull', ...patch}", b.id === "bull" && b.status === "ok" && b.loadScore === 0.2);
}
delete process.env.SAMS_CONTROL_TOKEN;

// ── NULL: no token → still posts (legacy-compat), WITHOUT the header ──
stubFetch();
{
  const r = await samsReport("bull", { status: "ok" }, { url: "https://castle.example" });
  check("NULL: still posts without a token (legacy-compat heartbeat)", r.ok === true && captured.length === 1);
  check("NULL: no token header on the request", captured[0].headers["x-sams-control-token"] === undefined);
}

// ── NULL: empty id → skipped no-op, nothing sent ──
stubFetch();
{
  const r = await samsReport("", { status: "ok" });
  check("NULL: empty id → skipped, no request", r.ok === false && r.skipped === true && captured.length === 0);
}

// ── FAIL paths: non-2xx and a throwing fetch NEVER break the caller ──
stubFetch(503);
{
  const r = await samsReport("bull", {}, { url: "https://castle.example" });
  check("FAIL: 503 → {ok:false,status:503}, never throws", r.ok === false && r.status === 503);
}
{
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED 127.0.0.1:4319"); }) as typeof fetch;
  let threw = false; let r: Awaited<ReturnType<typeof samsReport>> | null = null;
  try { r = await samsReport("bull", {}, { url: "http://127.0.0.1:1" }); } catch { threw = true; }
  check("FAIL: unreachable conductor → {ok:false}, never throws", !threw && r!.ok === false && /ECONNREFUSED/.test(r!.error ?? ""));
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
