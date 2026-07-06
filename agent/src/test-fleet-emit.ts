// SUCCESS / FAIL / NULL tests for fleet cost/event emission (no network — global.fetch is stubbed,
// same pattern as test-alpaca). Run: npm run test:fleet-emit
// Invariants under test: emissions are BEST-EFFORT — no control token → silent no-op (no request);
// conductor down / non-2xx / fetch throwing → {ok:false} returned, NEVER a throw (a ledger outage can
// never break a trading ritual); and the fleet-standard shapes go to POST /cost and POST /event with
// the x-sams-control-token header.
import { emitCost, emitEvent, controlToken, ritualTask, FLEET_AGENT } from "./fleet-emit.js";

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

const COST = { model: "claude-sonnet-4-6", inputTokens: 1200, outputTokens: 340, costUsd: 0.0123, task: "scan" };
const EVENT = { kind: "risk-halt", summary: "daily loss limit hit", ref: "2026-07-06", severity: "error" as const };

// ── NULL: no control token → silent no-op, nothing sent ──
delete process.env.SAMS_CONTROL_TOKEN;
stubFetch();
{
  const r = await emitCost(COST);
  check("NULL cost: no token → skipped no-op", r.ok === false && r.skipped === true);
  const e = await emitEvent(EVENT);
  check("NULL event: no token → skipped no-op", e.ok === false && e.skipped === true);
  check("NULL: no HTTP request was made", captured.length === 0);
  check("controlToken: '' when env absent", controlToken() === "");
}

// ── SUCCESS: fleet-standard shape + auth header to /cost and /event ──
stubFetch();
{
  const r = await emitCost(COST, { url: "https://castle.example/", token: "tok-123" });
  const req = captured[0];
  const b = req.body as Record<string, unknown>;
  check("cost: ok result on 2xx", r.ok === true && r.status === 200);
  check("cost: POST → <url>/cost (trailing slash normalized)", req.url === "https://castle.example/cost" && req.method === "POST");
  check("cost: x-sams-control-token header carried", req.headers["x-sams-control-token"] === "tok-123");
  check("cost: fleet shape {ts,agent:'bull',model,inputTokens,outputTokens,costUsd,task}",
    typeof b.ts === "string" && !Number.isNaN(Date.parse(String(b.ts))) && b.agent === FLEET_AGENT &&
    b.model === COST.model && b.inputTokens === 1200 && b.outputTokens === 340 && b.costUsd === 0.0123 && b.task === "scan");
}
stubFetch();
{
  const r = await emitEvent(EVENT, { url: "https://castle.example", token: "tok-123" });
  const req = captured[0];
  const b = req.body as Record<string, unknown>;
  check("event: ok result on 2xx", r.ok === true);
  check("event: POST → <url>/event", req.url === "https://castle.example/event");
  check("event: fleet shape {ts,agent:'bull',kind,summary,ref?,severity?}",
    typeof b.ts === "string" && b.agent === FLEET_AGENT && b.kind === "risk-halt" &&
    b.summary === EVENT.summary && b.ref === "2026-07-06" && b.severity === "error");
}

// ── env token is picked up when opts.token is absent ──
process.env.SAMS_CONTROL_TOKEN = "env-tok";
stubFetch();
{
  await emitEvent(EVENT, { url: "https://castle.example" });
  check("env: SAMS_CONTROL_TOKEN used as the header", captured[0]?.headers["x-sams-control-token"] === "env-tok");
}
delete process.env.SAMS_CONTROL_TOKEN;

// ── FAIL paths: absent/broken endpoint NEVER breaks the caller ──
{
  // fetch throws (conductor unreachable / DNS down / connection refused)
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED 127.0.0.1:4319"); }) as typeof fetch;
  let threw = false; let r: Awaited<ReturnType<typeof emitCost>> | null = null;
  try { r = await emitCost(COST, { url: "http://127.0.0.1:1", token: "tok" }); } catch { threw = true; }
  check("FAIL cost: unreachable endpoint → {ok:false}, never throws", !threw && r!.ok === false && /ECONNREFUSED/.test(r!.error ?? ""));
  let eThrew = false; let e: Awaited<ReturnType<typeof emitEvent>> | null = null;
  try { e = await emitEvent(EVENT, { url: "http://127.0.0.1:1", token: "tok" }); } catch { eThrew = true; }
  check("FAIL event: unreachable endpoint → {ok:false}, never throws", !eThrew && e!.ok === false);
}
stubFetch(401);
{
  const r = await emitCost(COST, { url: "https://castle.example", token: "bad" });
  check("FAIL: non-2xx (401) → {ok:false,status:401}, never throws", r.ok === false && r.status === 401);
}

// ── ritualTask: task label inferred from the entry script name ──
check("ritualTask: run-scan.ts → scan", ritualTask("/home/cj/bull/agent/src/run-scan.ts") === "scan");
check("ritualTask: windows path run-execute.ts → execute", ritualTask("C:\\bull\\agent\\src\\run-execute.ts") === "execute");
check("ritualTask: non-run script keeps its name", ritualTask("/x/agent-cli.ts") === "agent-cli");
check("ritualTask: empty argv → adhoc", ritualTask("") === "adhoc");

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
