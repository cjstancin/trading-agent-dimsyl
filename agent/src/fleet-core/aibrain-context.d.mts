export interface VaultScript {
  vault: string;
  script: string;
}
export interface AibrainContextOpts {
  project: string;
  /** Resolver falls back to this project when project is "auto" and inference finds no unambiguous match. */
  fallbackProject?: string;
  role?: string;
  sensitivity?: string;
  surface?: string;
  maxEvidence?: number;
  defaultVault?: string;
}
/** Resolve + validate the vault's context-resolver script; null when validation fails. */
export function resolveVaultScript(rawVault: string): VaultScript | null;
/** Load AIBRAIN context for a project (resolver stdout, or "" when disabled/unresolved/errored). Never throws. */
export function loadAibrainContext(description: string, opts: AibrainContextOpts): string;
