// Fleet observability — cost + event emission UP to the SAMS conductor's fleet ledgers.
// Twin of sams-report.ts (same URL source, same never-throw contract), for the two ledger endpoints:
//   POST /cost   {ts, agent:"bull", model, inputTokens, outputTokens, costUsd, task?}   — LLM spend
//   POST /event  {ts, agent:"bull", kind, summary, ref?, severity?}                      — key activity
// Both are BEST-EFFORT telemetry: authenticated with x-sams-control-token from SAMS_CONTROL_TOKEN; if the
// token is absent this is a silent no-op, and if the conductor is down/slow the call times out and returns
// {ok:false} — it NEVER throws, so a ledger outage can never break a trading ritual. Additive only: no
// trading behavior reads anything back from here.
import { withTimeout } from "./http-utils.js";
import { SAMS_URL } from "./sams-report.js";

export const FLEET_AGENT = "bull";

export interface FleetCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  task?: string; // which ritual spent it, e.g. "scan" / "execute" / "revalidate"
}

export interface FleetEvent {
  kind: string;      // e.g. "trades-proposed" | "trades-placed" | "risk-halt" | "revalidation-broken"
  summary: string;
  ref?: string;
  severity?: "info" | "warn" | "error";
}

export interface EmitResult { ok: boolean; status?: number; skipped?: boolean; error?: string }
export interface EmitOpts { url?: string; token?: string; timeoutMs?: number }

/** The fleet control token (x-sams-control-token). "" → emission is a no-op. */
export const controlToken = (): string => process.env.SAMS_CONTROL_TOKEN || "";

async function emit(path: "/cost" | "/event", body: Record<string, unknown>, opts: EmitOpts = {}): Promise<EmitResult> {
  const token = opts.token ?? controlToken();
  if (!token) return { ok: false, skipped: true, error: "no control token" }; // unconfigured → silent no-op
  const url = (opts.url ?? SAMS_URL).replace(/\/+$/, "") + path;
  try {
    const res = await withTimeout((signal) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sams-control-token": token },
      body: JSON.stringify(body),
      signal,
    }), opts.timeoutMs ?? 6000);
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `SAMS ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Emit one LLM ritual's spend to the fleet cost ledger. Best-effort; never throws. */
export function emitCost(cost: FleetCost, opts: EmitOpts = {}): Promise<EmitResult> {
  return emit("/cost", { ts: new Date().toISOString(), agent: FLEET_AGENT, ...cost }, opts);
}

/** Emit a key activity event (trades proposed/placed, risk-halt, revalidation-broken, …). Best-effort; never throws. */
export function emitEvent(event: FleetEvent, opts: EmitOpts = {}): Promise<EmitResult> {
  return emit("/event", { ts: new Date().toISOString(), agent: FLEET_AGENT, ...event }, opts);
}

/** Ritual/task label from the entry script's filename: ".../run-scan.ts" → "scan". Pure. */
export function ritualTask(argv1: string = process.argv[1] ?? ""): string {
  const base = String(argv1).replace(/\\/g, "/").split("/").pop() ?? "";
  const name = base.replace(/\.(ts|js|mjs|cjs)$/i, "").replace(/^run-/, "");
  return name || "adhoc";
}
