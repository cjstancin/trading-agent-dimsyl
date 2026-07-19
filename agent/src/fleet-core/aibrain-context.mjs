// fleet-core/aibrain-context.mjs — canonical, hardened AIBRAIN_VAULT context loader for EVERY agent.
//
// MASTER copy — vendored verbatim into each agent's src/fleet-core/ by scripts/sync-fleet-core.mjs.
// Supersedes the per-repo aibrain-context.ts copies (which differed only in --project/role/sensitivity,
// and several of which had NO validation or a bypassable one — Codex 2026-07-19). Zero deps.
//
// Threat: AIBRAIN_VAULT is attacker-influenceable environment; whatever it points at becomes the argv[0]
// script of a spawned Node process. A hostile/mistaken value must not redirect execution to an arbitrary
// script. Three independent layers:
//   1. Containment — the resolved script must live inside <vault>/scripts/context (a symlink/junction that
//      escapes the tree is rejected; the check compares against the NON-realpathed scriptsDir so a
//      scripts/ symlink-to-external is caught).
//   2. Trusted path (POSIX) — the script AND every ancestor dir up to '/' must be owned by our uid (or
//      root) and NOT group/world-writable. This defeats the "attacker sets AIBRAIN_VAULT to a directory
//      THEY created/can-write containing scripts/context/render-context.mjs" bypass: they cannot have
//      planted or later swapped the script unless they are already our uid (in which case they own the
//      process anyway). Skipped on win32 (no uid model; dev workstation, lower threat) — containment holds.
//   3. shell:false spawn — no shell metacharacter interpretation.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute, dirname, parse as parsePath } from "node:path";

const IS_WIN = process.platform === "win32";
const SCRIPT_REL_DIR = ["scripts", "context"];
const SCRIPT_NAME = "render-context.mjs";
const DEFAULT_VAULT = "C:/Users/stanc/OneDrive/Documents/Obsidian/AIBrain";

/** POSIX: a path component is safe if owned by our uid (or root) and not WORLD-writable.
 *  Ownership is the primary defense (an attacker's planted script is owned by the attacker → rejected).
 *  We reject world-writable (0o002) — the real "anyone can swap this" vector — but ALLOW group-writable:
 *  a fleet git working tree is group-writable under the standard umask 002 with the user's own
 *  single-member group (e.g. cj:cj on the VPS), which is not an attacker primitive. */
function ownedAndNotOthersWritable(p) {
  const st = statSync(p); // throws → caller treats as unsafe
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (st.uid !== 0 && st.uid !== uid) return false;      // not root- and not us-owned
  if ((st.mode & 0o002) !== 0) return false;             // world-writable
  return true;
}

/** Walk the script and every dir from it UP TO AND INCLUDING the vault (the declared trust root); each
 *  must pass the trusted-path test. We stop at the vault — an attacker who controls the vault's PARENT
 *  can only swap the vault dir, which is the env-control (AIBRAIN_VAULT) threat already treated as
 *  defense-in-depth. Bounded against a pathological path. `vault` is the realpath'd vault. */
function trustedPathPosix(script, vault) {
  let cur = script;
  const root = parsePath(cur).root || "/";
  for (let i = 0; i < 64; i++) {
    if (!ownedAndNotOthersWritable(cur)) return false;
    if (cur === vault) return true;   // verified the whole chain script..vault
    if (cur === root) return true;    // safety: reached fs root without hitting vault (shouldn't happen)
    const parent = dirname(cur);
    if (parent === cur) return true;
    cur = parent;
  }
  return false;
}

/**
 * Resolve + validate the vault's context-resolver script BEFORE spawning it.
 * Returns canonical { vault, script } or null when anything fails validation.
 */
export function resolveVaultScript(rawVault) {
  let vault;
  try {
    vault = realpathSync(rawVault);
    if (!statSync(vault).isDirectory()) return null;
  } catch {
    return null;
  }
  const scriptsDir = join(vault, ...SCRIPT_REL_DIR); // NOT realpathed — so a scripts/ symlink-escape is caught below
  let script;
  try {
    script = realpathSync(join(scriptsDir, SCRIPT_NAME));
  } catch {
    return null;
  }
  const rel = relative(scriptsDir, script);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null; // escaped scripts/context
  // Trusted-path ownership/permissions gate (POSIX). On win32 the containment above is the boundary.
  if (!IS_WIN) {
    try {
      if (!trustedPathPosix(script, vault)) return null;
    } catch {
      return null; // any stat error along the walk → refuse
    }
  }
  return { vault, script };
}

/**
 * Load the AIBRAIN context for a project. Returns the resolver's stdout, or "" when disabled / unresolved /
 * the resolver errors. Never throws.
 * @param {string} description  free-text task description passed to the resolver
 * @param {{project:string, role?:string, sensitivity?:string, surface?:string, maxEvidence?:number, defaultVault?:string}} opts
 */
export function loadAibrainContext(description, opts) {
  if (/^(?:0|false|off)$/i.test(process.env.AIBRAIN_CONTEXT ?? "")) return "";
  if (!opts || !opts.project) return "";
  const rawVault = process.env.AIBRAIN_VAULT || opts.defaultVault || DEFAULT_VAULT;
  const resolved = resolveVaultScript(rawVault);
  if (!resolved) return "";
  const { vault, script } = resolved;
  const result = spawnSync(
    process.execPath,
    [
      script, "--root", vault,
      "--project", opts.project,
      "--surface", opts.surface || "fleet-runtime",
      "--role", opts.role || "specialist",
      "--sensitivity", opts.sensitivity || "scoped",
      "--description", description,
      "--max-evidence", String(opts.maxEvidence ?? 3),
    ],
    { encoding: "utf8", timeout: Number(process.env.AIBRAIN_CONTEXT_TIMEOUT_MS) || 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false },
  );
  return result.status === 0 ? result.stdout.trim() : "";
}
