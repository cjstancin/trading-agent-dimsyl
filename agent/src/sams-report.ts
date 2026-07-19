// SAMS heartbeat — fire-and-forget telemetry UP. TS twin of the fleet `report(id, patch)` pattern
// (SAMS shared/report.mjs): POST the entity's status patch to the conductor's `/report` endpoint, which
// upserts {id, ...patch}. Used by run scripts that beat their own presence to SAMS (the dashboard does the
// same via assets/sams-boot.js). NEVER throws — telemetry must never break the caller, exactly like
// notify-discord.mjs. Zero deps; reuses withTimeout so the request always aborts.
//
// Conductor URL comes from SAMS_URL (default the local conductor). The Bull agent runs on CJ's PC, so ops
// sets SAMS_URL to the cloud conductor (e.g. https://castle.dimsylaisolutions.com) in .env. If the URL is
// unset/unreachable the call simply no-ops — the heartbeat is best-effort.
import { withTimeout } from "./http-utils.js";

export const SAMS_URL = (process.env.SAMS_URL || "http://127.0.0.1:4319").replace(/\/+$/, "");

export interface SamsResult { ok: boolean; status?: number; skipped?: boolean; error?: string }

/** The fleet control token, read LAZILY at call time (mirrors fleet-emit.ts). "" → header omitted. */
const controlToken = (): string => String(process.env.SAMS_CONTROL_TOKEN || "").trim();

/**
 * POST a status patch for agent `id` to the SAMS conductor. `patch` carries the standard registry fields
 * (name, kind, room, roomTitle, status, loadScore, metrics, event, …). Returns a result object; never throws.
 *
 * Sends `x-sams-control-token` whenever SAMS_CONTROL_TOKEN is set (fleet-audit fix #1 — this used to
 * post token-less while fleet-emit's /cost,/event carried the token, so the hardened conductor would
 * refuse the heartbeat and Bill would silently read OFFLINE mid-session). Without a token it still
 * posts bare — the conductor's legacy-compat path — so an unconfigured local run keeps working.
 * Kept local (not the fleet-core client) deliberately: heartbeat callers log this richer
 * {ok,status,error} result, which fleet-core's boolean report() does not carry.
 */
export async function samsReport(id: string, patch: Record<string, unknown> = {}, opts: { url?: string; timeoutMs?: number } = {}): Promise<SamsResult> {
  if (!id) return { ok: false, skipped: true, error: "no agent id" };
  const url = (opts.url ?? SAMS_URL).replace(/\/+$/, "") + "/report";
  const token = controlToken();
  try {
    const res = await withTimeout((signal) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-sams-control-token": token } : {}) },
      body: JSON.stringify({ id, ...patch }),
      signal,
    }), opts.timeoutMs ?? 6000);
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `SAMS ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
