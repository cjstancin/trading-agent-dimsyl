// fleet-core/sams-client.mjs — the ONE SAMS telemetry/control client for every fleet agent.
//
// MASTER copy, vendored verbatim into each agent's `src/fleet-core/` via scripts/sync-fleet-core.mjs.
// Replaces every per-repo `sams-report.ts` / `observe.ts` twin.
//
// ★ THE FLEET-WIDE FIX (fleet-audit finding #1): `report()` now sends `x-sams-control-token` WHENEVER
//   SAMS_CONTROL_TOKEN is set. Atlas/Bull/Press/Signal/Morpheus/Library all shipped a token-LESS
//   `/report`, so the moment the conductor enforces the control token (per-agent-token rollout, g2)
//   their heartbeats are refused (503) and they silently read OFFLINE on the Castle. This client
//   closes that in one place. Backward-compatible: with no token set, `report()` posts exactly as
//   before (the conductor's poller still detects presence).
//
//   report(meta, patch, opts)  → POST /report  (heartbeat/status; token sent when set; URL required)
//   postCost(cost, opts)       → POST /cost     (token REQUIRED — no unauthenticated control POST)
//   postEvent(event, opts)     → POST /event    (token REQUIRED)
//
// SAMS_URL + SAMS_CONTROL_TOKEN are read LAZILY at call time (entrypoints load .env after import).
// Per-call opts can override them ({ url, token, timeoutMs }) — used by callers with their own config
// plumbing and by tests injecting a stub conductor. Everything is bounded by withTimeout and NEVER
// throws — telemetry must never break a run.
import { withTimeout, DEFAULT_TIMEOUT_MS } from './http-utils.mjs';

const baseUrl = (opts = {}) => ((opts.url ?? process.env.SAMS_URL) || '').trim().replace(/\/+$/, '');
const controlToken = (opts = {}) => ((opts.token ?? process.env.SAMS_CONTROL_TOKEN) || '').trim();
const timeoutMs = (opts) => opts.timeoutMs ?? parseInt(process.env.SAMS_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

/**
 * Heartbeat/status to the conductor. `meta` carries identity ({ id, name, kind, room, sprite, ttlMs, … });
 * `patch` carries the status fields ({ status, loadScore, metrics, event, lastRun, nextRun }). Sends
 * `x-sams-control-token` when SAMS_CONTROL_TOKEN is set. No SAMS_URL → clean no-op. Never throws.
 * @returns {Promise<boolean>} true iff the conductor accepted the report (2xx).
 */
export async function report(meta = {}, patch = {}, opts = {}) {
  const url = baseUrl(opts);
  if (!url) return false;
  const token = controlToken(opts);
  const headers = { 'content-type': 'application/json', ...(token ? { 'x-sams-control-token': token } : {}) };
  const body = JSON.stringify({ status: 'ok', ...meta, ...patch });
  try {
    const r = await withTimeout(signal => fetch(`${url}/report`, { method: 'POST', headers, body, signal }), timeoutMs(opts));
    return !!(r && r.ok);
  } catch {
    return false; // unreachable conductor / timeout / anything → never break the caller
  }
}

// Cost + event are state-mutating control-plane routes: require BOTH url and token, and never emit an
// unauthenticated POST (matches the current observe.ts contract).
async function controlPost(path, payload, opts = {}) {
  const url = baseUrl(opts);
  const token = controlToken(opts);
  if (!url || !token) return false;
  try {
    const r = await withTimeout(signal => fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sams-control-token': token },
      body: JSON.stringify(payload),
      signal,
    }), timeoutMs(opts));
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

/** Emit one cost record to the fleet cost ledger (POST /cost). `ts` stamped when omitted. Never throws. */
export function postCost(cost = {}, opts = {}) { return controlPost('/cost', { ts: new Date().toISOString(), ...cost }, opts); }

/** Emit one event to the fleet event timeline (POST /event). `ts` stamped when omitted. Never throws. */
export function postEvent(event = {}, opts = {}) { return controlPost('/event', { ts: new Date().toISOString(), ...event }, opts); }
