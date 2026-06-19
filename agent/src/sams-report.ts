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

/**
 * POST a status patch for agent `id` to the SAMS conductor. `patch` carries the standard registry fields
 * (name, kind, room, roomTitle, status, loadScore, metrics, event, …). Returns a result object; never throws.
 */
export async function samsReport(id: string, patch: Record<string, unknown> = {}, opts: { url?: string; timeoutMs?: number } = {}): Promise<SamsResult> {
  if (!id) return { ok: false, skipped: true, error: "no agent id" };
  const url = (opts.url ?? SAMS_URL).replace(/\/+$/, "") + "/report";
  try {
    const res = await withTimeout((signal) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
      signal,
    }), opts.timeoutMs ?? 6000);
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `SAMS ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
