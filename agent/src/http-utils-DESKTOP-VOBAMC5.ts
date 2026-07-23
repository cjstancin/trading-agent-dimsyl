// Fleet-standard HTTP + process utilities — a re-export of the vendored fleet-core master
// (src/fleet-core/http-utils.mjs, synced verbatim from castle/shared/fleet-core by
// castle/scripts/sync-fleet-core.mjs). Existing importers keep their `./http-utils.js` specifier;
// the ONE implementation lives in fleet-core. See Projects/SAMS/docs/BACKEND-CONVENTIONS.md.
export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BODY_CAP,
  withTimeout,
  readBodyCapped,
  corsHeaders,
  installSafetyNet,
  healthPayload,
  timingSafeTokenMatch,
} from "./fleet-core/http-utils.mjs";

export interface CorsOpts { origin?: string; methods?: string; headers?: string }
