// Fleet-standard HTTP utilities — TypeScript twin of SAMS/shared/http-utils.mjs. Same names, same
// semantics. See Projects/SAMS/docs/BACKEND-CONVENTIONS.md for the contract.
//
//   withTimeout(make, ms)        — race a fetch against a timeout; always aborts the request
//   readBodyCapped(req, cap)     — drain an IncomingMessage body, refusing payloads beyond `cap`
//   corsHeaders(res, opts)       — set the standard CORS triplet (Bull control-server stays localhost-only,
//                                  so this is mostly used for explicit no-CORS responses; available if needed)
//   installSafetyNet(service)    — process-wide unhandledRejection / uncaughtException handlers
//
// Zero deps. withTimeout rejects on abort / network error; readBodyCapped rejects when the cap is hit.
import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_TIMEOUT_MS = 9000;
export const DEFAULT_BODY_CAP = 1_000_000; // 1 MB

/** Race fetch() against a timeout. `make(signal)` is called with an AbortSignal — pass it to fetch. */
export async function withTimeout<T>(make: (signal: AbortSignal) => Promise<T>, ms: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await make(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Drain a Node IncomingMessage into a string, REJECTING the promise if more than `cap` bytes arrive. */
export function readBodyCapped(req: IncomingMessage, cap: number = DEFAULT_BODY_CAP): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    req.on("data", (d: Buffer | string) => {
      if (done) return;
      buf += d;
      if (buf.length > cap) {
        done = true;
        try { req.destroy(); } catch { /* socket already gone */ }
        reject(new Error(`body too large (> ${cap} bytes)`));
      }
    });
    req.on("end", () => { if (!done) { done = true; resolve(buf); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

export interface CorsOpts { origin?: string; methods?: string; headers?: string }

/** Apply the standard CORS triplet. Caller can override individual headers afterwards if needed. */
export function corsHeaders(res: ServerResponse, opts: CorsOpts = {}): void {
  const { origin = "*", methods = "GET, POST, OPTIONS", headers = "content-type" } = opts;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", methods);
  res.setHeader("access-control-allow-headers", headers);
}

/** Install fleet-standard process safety net. Same pattern as SAMS index.mjs / Atlas atlas-server.ts. */
export function installSafetyNet(service: string): void {
  process.on("unhandledRejection", (err) => console.error(`[${service}] unhandled rejection:`, err));
  process.on("uncaughtException", (err) => { console.error(`[${service}] uncaught exception:`, err); process.exit(1); });
}
