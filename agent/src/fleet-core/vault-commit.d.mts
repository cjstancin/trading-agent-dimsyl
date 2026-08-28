// Type declarations for fleet-core/vault-commit.mjs — vendored beside it by sync-fleet-core.mjs.
// NodeNext resolution maps a `./vault-commit.mjs` import to this `.d.mts`. Keep in lockstep with the
// implementation. Note: the types are deliberately STRICTER than the runtime (user/email/tag are required
// here; the runtime falls back to tag-derived defaults) — the contract every fleet caller should meet.

export interface VaultCommitOptions {
  /** Caller's per-agent flag (e.g. `process.env.LIBRARY_VAULT_AUTOSYNC === "1"`). False → clean no-op. */
  enabled: boolean;
  /** The shared vault working tree (AIBRAIN_VAULT). Empty/absent → clean no-op. */
  vaultDir: string;
  /** The caller's OWN paths, vault-relative. NEVER a bare "." / "-A" / "--all" (refused). */
  pathspecs: string[];
  /** Commit message. */
  message: string;
  /** Committer name (e.g. `"library (the-fleet)"`). */
  user: string;
  /** Committer email (e.g. `"library@dimsylaisolutions.com"`). */
  email: string;
  /** Short agent id for logs + the per-agent push-failure escalation counter (e.g. `"library"`). */
  tag: string;
  /** Max ms to wait for the cross-process vault lock before deferring (default 30_000). */
  lockWaitMs?: number;
  /** Called with one message at PUSH_FAIL_THRESHOLD (3) consecutive rebase/push failures. */
  onPushFailStreak?: (msg: string) => void | Promise<void>;
}

export interface VaultCommitResult {
  /** False only on a real failure (add/commit/rebase/push failed, or an unscoped pathspec was refused). */
  ok: boolean;
  /** True iff a commit was created this call (it may still be local-only when rebase/push failed). */
  committed: boolean;
  /** Human-readable disposition (e.g. "ok", "disabled", "nothing changed in lane", "lock timeout (deferred)"). */
  reason: string;
}

/**
 * Commit + push the caller's OWN vault changes, scoped to `pathspecs` (never `git add -A`), serialized
 * against every other writer on the shared tree by an O_EXCL lockfile under `<vaultDir>/.git/`. No-op when
 * disabled, when the vault is unset, or when nothing in the caller's lane changed. Never throws.
 */
export declare function commitVaultScoped(o: VaultCommitOptions): Promise<VaultCommitResult>;
