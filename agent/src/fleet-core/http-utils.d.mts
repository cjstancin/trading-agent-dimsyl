// Type declarations for fleet-core/http-utils.mjs — vendored beside it by sync-fleet-core.mjs.
// NodeNext resolution maps an `./http-utils.mjs` import to this `.d.mts`, so strict-TS agents get
// full types with no build step. Keep in lockstep with the implementation.
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DEFAULT_BODY_CAP: number;

/** Race fetch() against a timeout. `make(signal)` is called with an AbortSignal — pass it to fetch. */
export declare function withTimeout<T>(make: (signal: AbortSignal) => Promise<T>, ms?: number): Promise<T>;

/** Drain a Node IncomingMessage into a string, REJECTING the promise if more than `cap` bytes arrive. */
export declare function readBodyCapped(req: IncomingMessage, cap?: number): Promise<string>;

/** Apply the standard CORS triplet. Caller can override individual headers afterwards if needed. */
export declare function corsHeaders(
  res: ServerResponse,
  opts?: { origin?: string; methods?: string; headers?: string },
): void;

/** Last-resort unhandledRejection/uncaughtException guards. BACKEND-CONVENTIONS §4 — once per entrypoint. */
export declare function installSafetyNet(service?: string): void;

/** The canonical GET /health body. BACKEND-CONVENTIONS §3. */
export interface HealthPayload {
  ok: boolean;
  service: string;
  uptimeSec: number;
  [key: string]: unknown;
}
export declare function healthPayload(service: string, extra?: Record<string, unknown>): HealthPayload;

/** Constant-time token compare; empty expected or provided NEVER matches (fail closed). */
export declare function timingSafeTokenMatch(provided: string | null | undefined, expected: string | null | undefined): boolean;
