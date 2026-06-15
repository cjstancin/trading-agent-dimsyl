// Risk profile toggle: aggressive | steady. Selects which guardrail rulebook the executor uses.
//   aggressive — wider position cap, more open positions, lower price floor, looser stops.
//   steady     — conservative: tighter cap, fewer positions, higher quality floor, tighter stops.
// Source of truth = the ../PROFILE file (one word). Env BILL_PROFILE overrides it. Default = aggressive.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Profile = "aggressive" | "steady";
export const PROFILES: Profile[] = ["aggressive", "steady"];

const PROFILE_FILE = fileURLToPath(new URL("../PROFILE", import.meta.url));

function normalize(v: string | undefined): Profile | null {
  const s = (v ?? "").trim().toLowerCase();
  return (PROFILES as string[]).includes(s) ? (s as Profile) : null;
}

/** Resolve the active risk profile. Env override → PROFILE file → "aggressive". */
export function getProfile(): Profile {
  return normalize(process.env.BILL_PROFILE) ?? readProfileFile() ?? "aggressive";
}

export function readProfileFile(): Profile | null {
  try { return normalize(readFileSync(PROFILE_FILE, "utf8")); } catch { return null; }
}

export function setProfile(p: Profile): void {
  if (!PROFILES.includes(p)) throw new Error(`Invalid profile "${p}". Use one of: ${PROFILES.join(", ")}`);
  writeFileSync(PROFILE_FILE, p + "\n");
}
