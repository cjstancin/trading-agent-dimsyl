// fleet-core/vault-commit.mjs — per-agent, scoped, serialized commit-on-write for the shared vault.
//
// MASTER copy — vendored verbatim into each agent's src/fleet-core/ by scripts/sync-fleet-core.mjs and
// verified by fleet-core/check-vendored.mjs. Zero deps.
//
// WHY THIS EXISTS: the fleet shares ONE vault working tree on the box (/home/cj/aibrain, AIBRAIN_VAULT).
// Historically only Atlas committed, via `git add -A` at its EOD ritual — a catch-all that swept every
// other agent's dirty files into one commit, so a writer's output stayed invisible until that ritual ran
// (the propagation lag). This lets each writer commit + push ITS OWN output the moment it writes, scoped
// to ITS pathspecs (NEVER `git add -A` — that grabs foreign/half-written files, a standing vault rule).
//
// SERIALIZATION: all writers share one git index, so two concurrent commits collide. commitVaultScoped
// takes a cross-process lock (an O_EXCL lockfile under .git/) around the whole add→commit→push sequence,
// blocking up to lockWaitMs, then DEFERRING (returns without committing — the caller's next run retries).
// A stale lock (holder died) is reclaimed after STALE_LOCK_MS.
//
// SAFETY: never throws — a sync failure must never break the producing ritual. Gated by an explicit
// `enabled` boolean the caller derives from its OWN per-agent flag (e.g. LIBRARY_VAULT_AUTOSYNC=1), so
// nothing runs on the PC (where Obsidian owns the commit cadence).
import { spawn } from "node:child_process";
import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOCK_POLL_MS = 250;
const STALE_LOCK_MS = 5 * 60_000; // a lock older than this is assumed abandoned (holder died mid-commit)
const PUSH_FAIL_THRESHOLD = 3;

/** Run a git command in `vaultDir`. Resolves { code, stdout, stderr }; never throws. */
function git(vaultDir, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", vaultDir, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    const killer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } settle({ code: -2, stdout, stderr: stderr + "\n[vault-commit] git timeout" }); }, timeoutMs);
    killer.unref();
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(killer); settle({ code: -3, stdout, stderr: stderr + "\n" + String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(killer); settle({ code: code ?? -4, stdout, stderr }); });
  });
}

// NB: do NOT unref this timer — a caller waiting for the lock has nothing else holding the event loop
// while it polls, so an unref'd timer would let Node drain the loop and abandon the wait.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire the cross-process vault commit lock (O_EXCL create of a lockfile). Blocks up to lockWaitMs,
 * polling every LOCK_POLL_MS. Reclaims a lock older than STALE_LOCK_MS (the previous holder died mid-commit
 * and left it behind). Returns the lock path on success, or null on timeout. Never throws.
 */
async function acquireLock(vaultDir, lockWaitMs, tag) {
  const lockPath = join(vaultDir, ".git", "aibrain-commit.lock");
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — fails if it exists
      try { writeFileSync(fd, JSON.stringify({ tag, pid: process.pid, at: new Date().toISOString() })); } catch { /* best-effort stamp */ }
      closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e?.code !== "EEXIST") return null; // unexpected FS error — do not spin, defer
      // Lock held. Reclaim if stale, else wait.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) { try { unlinkSync(lockPath); } catch { /* someone else reclaimed */ } continue; }
      } catch { /* lock vanished between calls — retry the create */ }
      if (Date.now() >= deadline) return null; // timed out — caller defers to its next run
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

// Consecutive-push-failure escalation, per agent (a wedged vault silently diverges from GitHub). The
// counter lives in tmpdir keyed by tag so separate ritual processes share it. Best-effort; never throws.
const failCountFile = (tag) => join(tmpdir(), `vault-commit-push-failures-${String(tag).replace(/[^a-z0-9]+/gi, "-")}.json`);
function readFailCount(tag) {
  try { const n = JSON.parse(readFileSync(failCountFile(tag), "utf8")).count; return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}
function writeFailCount(tag, count) {
  try { writeFileSync(failCountFile(tag), JSON.stringify({ count, at: new Date().toISOString() })); } catch { /* best-effort */ }
}

/**
 * Commit + push the caller's OWN vault changes, scoped to `pathspecs`. Serialized against every other
 * writer on the shared tree. No-op (committed:false) when disabled, when the vault is unset, or when
 * nothing in the caller's lane changed. Never throws.
 *
 * @param {object} o
 * @param {boolean} o.enabled       caller's per-agent flag (e.g. process.env.LIBRARY_VAULT_AUTOSYNC === "1")
 * @param {string}  o.vaultDir      AIBRAIN_VAULT
 * @param {string[]} o.pathspecs    the caller's OWN paths, vault-relative (NEVER a bare "." / "-A")
 * @param {string}  o.message       commit message
 * @param {string}  o.user          committer name
 * @param {string}  o.email         committer email
 * @param {string}  o.tag           short agent id for logs + the escalation counter (e.g. "library")
 * @param {number} [o.lockWaitMs]   max ms to wait for the lock before deferring (default 30_000)
 * @param {(msg:string)=>Promise<void>|void} [o.onPushFailStreak]  called at PUSH_FAIL_THRESHOLD consecutive failures
 * @returns {Promise<{ok:boolean, committed:boolean, reason:string}>}
 */
export async function commitVaultScoped(o) {
  const { enabled, vaultDir, pathspecs, message, user, email, tag = "agent", lockWaitMs = 30_000, onPushFailStreak } = o || {};
  if (!enabled) return { ok: true, committed: false, reason: "disabled" };
  if (!vaultDir) return { ok: true, committed: false, reason: "AIBRAIN_VAULT not set" };
  if (!Array.isArray(pathspecs) || pathspecs.length === 0) return { ok: true, committed: false, reason: "no pathspecs" };
  // Refuse a pathspec that would widen the lane to the whole tree (defense-in-depth vs the git add -A rule).
  if (pathspecs.some((p) => typeof p !== "string" || p.trim() === "" || p.trim() === "." || p.trim() === "-A" || p.trim() === "--all")) {
    return { ok: false, committed: false, reason: "refusing an unscoped pathspec (., -A, --all, or empty)" };
  }

  const lockPath = await acquireLock(vaultDir, lockWaitMs, tag);
  if (!lockPath) { console.error(`[vault-commit:${tag}] lock busy after ${lockWaitMs}ms — deferring to next run`); return { ok: true, committed: false, reason: "lock timeout (deferred)" }; }

  try {
    await git(vaultDir, ["config", "user.name", user || `${tag} (the-fleet)`]);
    await git(vaultDir, ["config", "user.email", email || `${tag}@dimsylaisolutions.com`]);

    const add = await git(vaultDir, ["add", "--", ...pathspecs]);
    if (add.code !== 0) { console.error(`[vault-commit:${tag}] add failed: ${add.stderr.trim().slice(0, 200)}`); return { ok: false, committed: false, reason: "add failed" }; }

    // Nothing staged in THIS lane → clean no-op (the caller wrote nothing new; other agents' dirty files
    // are untouched because the add was scoped).
    const staged = await git(vaultDir, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return { ok: true, committed: false, reason: "nothing changed in lane" };

    const commit = await git(vaultDir, ["commit", "-m", message]);
    if (commit.code !== 0) { console.error(`[vault-commit:${tag}] commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 200)}`); return { ok: false, committed: false, reason: "commit failed" }; }

    // Re-sync before push in case another writer (or the PC) pushed concurrently. --rebase --autostash
    // recovers a diverged history; abort a conflicted rebase so we never wedge the tree mid-rebase.
    const rebase = await git(vaultDir, ["pull", "--rebase", "--autostash", "--quiet"], 60_000);
    if (rebase.code !== 0) {
      await git(vaultDir, ["rebase", "--abort"], 30_000); // best-effort; no-op if not mid-rebase
      console.error(`[vault-commit:${tag}] pull --rebase failed: ${(rebase.stderr || rebase.stdout).trim().slice(0, 200)} — leaving commit for next sync`);
      await noteFail(tag, `pull --rebase failed: ${rebase.stderr || rebase.stdout}`, onPushFailStreak);
      return { ok: false, committed: true, reason: "rebase failed (commit kept)" };
    }

    const push = await git(vaultDir, ["push", "--quiet"], 60_000);
    if (push.code !== 0) {
      console.error(`[vault-commit:${tag}] push failed: ${push.stderr.trim().slice(0, 200)} — leaving commit for next sync`);
      await noteFail(tag, `push failed: ${push.stderr}`, onPushFailStreak);
      return { ok: false, committed: true, reason: "push failed (commit kept)" };
    }

    writeFailCount(tag, 0);
    console.error(`[vault-commit:${tag}] commit + push ok: ${message}`);
    return { ok: true, committed: true, reason: "ok" };
  } finally {
    releaseLock(lockPath);
  }
}

async function noteFail(tag, detail, onPushFailStreak) {
  const count = readFailCount(tag) + 1;
  if (count < PUSH_FAIL_THRESHOLD) { writeFailCount(tag, count); return; }
  writeFailCount(tag, 0); // alerted (or tried) — restart the window
  if (typeof onPushFailStreak === "function") {
    try { await onPushFailStreak(`${count} consecutive vault push failures on this box (${tag}); local commits are NOT reaching GitHub. Latest: ${String(detail).trim().slice(0, 400)}`); }
    catch (e) { console.error(`[vault-commit:${tag}] escalation hook failed:`, e instanceof Error ? e.message : e); }
  }
}
