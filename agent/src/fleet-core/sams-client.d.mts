// Type declarations for fleet-core/sams-client.mjs — vendored beside it by sync-fleet-core.mjs.
// NodeNext resolution maps a `./sams-client.mjs` import to this `.d.mts`. Keep in lockstep with the
// implementation. Note: the types are deliberately STRICTER than the runtime (meta.id and the cost/event
// payload fields are required here; the runtime tolerates {}) — the contract every fleet caller should meet.

export interface SamsClientOpts {
  /** Override the per-call timeout; defaults to SAMS_TIMEOUT_MS or DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Override the conductor base URL; defaults to env SAMS_URL. Empty/absent → clean no-op. */
  url?: string;
  /** Override the control token; defaults to env SAMS_CONTROL_TOKEN. */
  token?: string;
}

export type SamsStatus = 'ok' | 'warn' | 'error' | 'paused' | 'offline';

/** Identity fields for POST /report ({ id, name, kind, room, sprite, ttlMs, … }). */
export interface SamsReportMeta {
  id: string;
  name?: string;
  kind?: string;
  room?: string;
  roomTitle?: string;
  sprite?: string;
  theme?: string;
  managedBy?: string;
  ttlMs?: number;
  [key: string]: unknown;
}

/** Status fields for POST /report. */
export interface SamsReportPatch {
  status?: SamsStatus;
  loadScore?: number;
  metrics?: Record<string, unknown>;
  event?: { type: string; text: string; level?: 'info' | 'warn' | 'error' };
  lastRun?: string;
  nextRun?: string;
  [key: string]: unknown;
}

/**
 * Heartbeat/status to the conductor. Sends `x-sams-control-token` when SAMS_CONTROL_TOKEN is set
 * (the fleet-wide fix). No SAMS_URL → clean no-op. Never throws.
 * @returns true iff the conductor accepted the report (2xx).
 */
export declare function report(meta: SamsReportMeta, patch?: SamsReportPatch, opts?: SamsClientOpts): Promise<boolean>;

/** Fleet cost-ledger record (conductor POST /cost). `ts` is stamped at emit time when omitted. */
export interface FleetCost {
  ts?: string;
  agent?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  task?: string;
  [key: string]: unknown;
}

/** Fleet event-timeline record (conductor POST /event). `ts` is stamped at emit time when omitted. */
export interface FleetEvent {
  ts?: string;
  agent?: string;
  kind: string;
  summary: string;
  ref?: string;
  severity?: 'info' | 'warn' | 'error';
  [key: string]: unknown;
}

/** Emit one cost record (POST /cost). Token REQUIRED — no unauthenticated control POST. Never throws. */
export declare function postCost(cost: FleetCost, opts?: SamsClientOpts): Promise<boolean>;

/** Emit one event (POST /event). Token REQUIRED — no unauthenticated control POST. Never throws. */
export declare function postEvent(event: FleetEvent, opts?: SamsClientOpts): Promise<boolean>;
