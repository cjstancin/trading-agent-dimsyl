import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const DEFAULT_VAULT = "C:/Users/stanc/OneDrive/Documents/Obsidian/AIBrain";
const SCRIPT_REL = ["scripts", "context", "render-context.mjs"];

/**
 * Resolve + VALIDATE the context-render script we are about to hand to Node before executing it.
 *
 * AIBRAIN_VAULT is attacker-influenceable environment: whatever it points at becomes the first argv of a
 * spawned `node <script>` call, i.e. arbitrary-code-execution if a hostile value can steer that path.
 * Defence in depth here: the vault must be a REAL existing directory, and the script must physically
 * resolve (realpathSync collapses symlinks/junctions/`..`) to a path INSIDE <vault>/scripts. A
 * render-context.mjs that is a symlink/junction pointing out of the vault, or a `..`-escaping vault, is
 * rejected rather than executed. Returns null on any failure → the caller loads no context (never execs).
 * (spawnSync is always called shell:false — its default — so no shell metacharacter is ever interpreted.)
 */
function resolveContextScript(rawVault: string): { vault: string; script: string } | null {
  try {
    const vault = realpathSync(resolve(rawVault));
    if (!statSync(vault).isDirectory()) return null;
    const scriptsRoot = realpathSync(join(vault, "scripts"));
    const candidate = join(vault, ...SCRIPT_REL);
    if (!existsSync(candidate)) return null;
    const script = realpathSync(candidate);
    const prefix = scriptsRoot.endsWith(sep) ? scriptsRoot : scriptsRoot + sep;
    if (!script.startsWith(prefix)) return null; // symlink / traversal escaped <vault>/scripts
    return { vault, script };
  } catch {
    return null;
  }
}

export function loadAibrainContext(description: string): string {
  if (/^(?:0|false|off)$/i.test(process.env.AIBRAIN_CONTEXT ?? "")) return "";
  const resolved = resolveContextScript(process.env.AIBRAIN_VAULT || DEFAULT_VAULT);
  if (!resolved) return "";
  const result = spawnSync(process.execPath, [resolved.script, "--root", resolved.vault, "--project", "bull", "--surface", "fleet-runtime", "--role", "restricted-specialist", "--sensitivity", "restricted", "--description", description, "--max-evidence", "3"], { encoding: "utf8", timeout: Number(process.env.AIBRAIN_CONTEXT_TIMEOUT_MS) || 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Exported for the regression test only — validates the vault/script resolution gate in isolation. */
export const __resolveContextScript = resolveContextScript;
