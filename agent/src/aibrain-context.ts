import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function loadAibrainContext(description: string): string {
  if (/^(?:0|false|off)$/i.test(process.env.AIBRAIN_CONTEXT ?? "")) return "";
  const vault = process.env.AIBRAIN_VAULT || "C:/Users/stanc/OneDrive/Documents/Obsidian/AIBrain";
  const script = join(vault, "scripts/context/render-context.mjs");
  if (!existsSync(script)) return "";
  const result = spawnSync(process.execPath, [script, "--root", vault, "--project", "bull", "--surface", "fleet-runtime", "--role", "restricted-specialist", "--sensitivity", "restricted", "--description", description, "--max-evidence", "3"], { encoding: "utf8", timeout: Number(process.env.AIBRAIN_CONTEXT_TIMEOUT_MS) || 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}
