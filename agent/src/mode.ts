// Agent mode toggle: off | gated | auto.
//   off   — the agent does nothing (rituals exit immediately).
//   gated — the agent analyzes + PROPOSES actions and waits for human approval; it executes NOTHING.
//   auto  — the agent executes within the rulebook limits (paper only).
// Source of truth = the ../MODE file (one word). Env BILL_MODE / AGENT_MODE overrides it. Default = off (safest).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Mode = "off" | "gated" | "auto";
export const MODES: Mode[] = ["off", "gated", "auto"];

const MODE_FILE = fileURLToPath(new URL("../MODE", import.meta.url));

function normalize(v: string | undefined): Mode | null {
  const s = (v ?? "").trim().toLowerCase();
  return (MODES as string[]).includes(s) ? (s as Mode) : null;
}

/** Resolve the current mode. Env override → MODE file → "off". */
export function getMode(): Mode {
  return normalize(process.env.BILL_MODE) ?? normalize(process.env.AGENT_MODE) ?? readModeFile() ?? "off";
}

export function readModeFile(): Mode | null {
  try {
    return normalize(readFileSync(MODE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function setMode(m: Mode): void {
  if (!MODES.includes(m)) throw new Error(`Invalid mode "${m}". Use one of: ${MODES.join(", ")}`);
  writeFileSync(MODE_FILE, m + "\n");
}

/** Auto-execution requires BOTH MODE=auto AND an explicit env opt-in, so it can never trigger by accident. */
export function autoExecAllowed(): boolean {
  return getMode() === "auto" && process.env.BILL_ALLOW_AUTO_EXEC === "1";
}
