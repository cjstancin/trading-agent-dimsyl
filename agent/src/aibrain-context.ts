// AIBRAIN_VAULT context loader for Bill — a thin wrapper over the vendored fleet-core master
// (src/fleet-core/aibrain-context.mjs, synced verbatim from castle/shared/fleet-core by
// castle/scripts/sync-fleet-core.mjs). Existing importers keep the `./aibrain-context.js` specifier; the
// ONE hardened implementation lives in fleet-core. See Projects/SAMS/docs/BACKEND-CONVENTIONS.md.
//
// The master closes the arbitrary-exec bypass Codex flagged: AIBRAIN_VAULT is attacker-influenceable env,
// and whatever it points at becomes argv[0] of a spawned Node process. An attacker who controls
// AIBRAIN_VAULT could previously aim it at a directory THEY created containing
// scripts/context/render-context.mjs and have it executed. The master defends in depth — containment
// (the resolved script must stay inside <vault>/scripts/context, symlink/junction escapes rejected) +
// a POSIX trusted-path gate (the script and its ancestor dirs up to the vault must be owned by our
// uid/root and not world-writable, so an attacker-writable planted script is refused) + shell:false spawn.
//
// This file only pins Bill's project identity; all validation + spawning lives in the master.
import { loadAibrainContext as core, resolveVaultScript } from "./fleet-core/aibrain-context.mjs";

export { resolveVaultScript };

/** Load AIBRAIN context for Bill (a restricted paper-trading specialist). Returns the resolver's stdout,
 *  or "" when disabled/unresolved/errored. Never throws. Surface + max-evidence take the master's defaults
 *  ("fleet-runtime", 3) — identical to the prior per-repo copy's `--surface fleet-runtime --max-evidence 3`. */
export function loadAibrainContext(description: string): string {
  return core(description, { project: "bull", role: "restricted-specialist", sensitivity: "restricted" });
}
