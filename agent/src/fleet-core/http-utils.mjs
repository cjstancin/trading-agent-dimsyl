// fleet-core/http-utils.mjs — canonical HTTP + process utilities for EVERY fleet backend.
//
// This is the MASTER copy. It is vendored verbatim into each agent's `src/fleet-core/` by
// `scripts/sync-fleet-core.mjs` (CI-checked with --check), superseding the hand-copied per-repo
// http-utils twins that drifted across Atlas/Bull/Press/Signal/Morpheus/Library (see the fleet-audit
// target architecture). Zero deps. Nothing here throws except where documented.
//
//   withTimeout(make, ms)     — race a fetch against a timeout; always aborts the request
//   readBodyCapped(req, cap)  — drain a Node IncomingMessage body, refusing payloads beyond `cap`
//   corsHeaders(res, opts)    — set the standard CORS triplet
//   installSafetyNet(service) — last-resort unhandledRejection/uncaughtException guards (§4)
//   healthPayload(service, x) — the canonical GET /health body { ok, service, uptimeSec, ... } (§3)
//   timingSafeTokenMatch(p,e) — constant-time token compare, fail-closed on empty (from Atlas)
import { timingSafeEqual } from 'node:crypto';

export const DEFAULT_TIMEOUT_MS = 9000;
export const DEFAULT_BODY_CAP   = 1_000_000;  // 1 MB

/** Race fetch() against a timeout. `make(signal)` is called with an AbortSignal — pass it to fetch. */
export async function withTimeout(make, ms = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await make(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Drain a Node IncomingMessage into a string, REJECTING the promise if more than `cap` bytes arrive. */
export function readBodyCapped(req, cap = DEFAULT_BODY_CAP) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    req.on('data', d => {
      if (done) return;
      buf += d;
      if (buf.length > cap) {
        done = true;
        try { req.destroy(); } catch { /* socket already gone */ }
        reject(new Error(`body too large (> ${cap} bytes)`));
      }
    });
    req.on('end', () => { if (!done) { done = true; resolve(buf); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

/** Apply the standard CORS triplet. Caller can override individual headers afterwards if needed. */
export function corsHeaders(res, { origin = '*', methods = 'GET, POST, OPTIONS', headers = 'content-type' } = {}) {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', methods);
  res.setHeader('access-control-allow-headers', headers);
}

/**
 * Install last-resort process guards so a stray rejection/throw is logged (and, for an uncaught
 * exception, the process exits non-zero so the supervisor restarts it) rather than dying silently.
 * BACKEND-CONVENTIONS §4 — call once at the top of every entrypoint.
 */
export function installSafetyNet(service = 'agent') {
  process.on('unhandledRejection', (reason) => {
    console.error(`[${service}] unhandledRejection:`, reason);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${service}] uncaughtException:`, err);
    process.exit(1);
  });
}

/** The canonical GET /health body. `extra` merges in service-specific fields. BACKEND-CONVENTIONS §3. */
export function healthPayload(service, extra = {}) {
  return { ok: true, service, uptimeSec: Math.round(process.uptime()), ...extra };
}

/** Constant-time token compare (length mismatch short-circuits, which leaks only the length).
 *  Empty/absent expected OR provided → NEVER matches (fail closed). Folded in from Atlas. */
export function timingSafeTokenMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
