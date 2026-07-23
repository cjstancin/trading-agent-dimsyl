// Security regression tests for aibrain-context — now a thin wrapper over the vendored fleet-core master
// (src/fleet-core/aibrain-context.mjs). Verifies (a) the wrapper DELEGATES to the master with Bill's exact
// project identity (project=bull, role=restricted-specialist, sensitivity=restricted, and passes the
// description + fleet-runtime/max-evidence=3 defaults through), and (b) the master's AIBRAIN_VAULT
// arbitrary-exec hardening: containment (symlink/junction escape rejected) + the POSIX trusted-path gate
// (a group/world-writable script is refused, never spawned). No network. Run: npm run test:aibrain-context
//
// NOTE ON TEST LOCATION: the master's POSIX trusted-path gate walks the resolver script up through its
// ancestor dirs to the vault, requiring each is owned by us/root and not world-writable. We build the
// *trusted* fixtures under the repo tree (owned by us, not world-writable) rather than os.tmpdir() so they
// pass that gate deterministically on the Linux VPS/CI, independent of where os.tmpdir() lives or its mode.
// The world-writable refusal is exercised explicitly by the chmod sub-test below.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAibrainContext, resolveVaultScript } from "./aibrain-context.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// Trusted base: under the agent package dir (not /tmp) so POSIX ancestry passes the master's trusted-path gate.
const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(AGENT_DIR, ".tmp-aibrain-ctx-"));
const withVault = (v: string, fn: () => void) => {
  const prev = process.env.AIBRAIN_VAULT;
  process.env.AIBRAIN_VAULT = v;
  try { fn(); } finally { if (prev === undefined) delete process.env.AIBRAIN_VAULT; else process.env.AIBRAIN_VAULT = prev; }
};

// Build a vault whose scripts/context/render-context.mjs writes `body` to stdout and exits 0.
function makeVault(name: string, body: string): string {
  const v = join(base, name);
  mkdirSync(join(v, "scripts", "context"), { recursive: true });
  writeFileSync(join(v, "scripts", "context", "render-context.mjs"), body);
  return v;
}
// A render script that echoes its argv — lets the delegation test read back exactly what the wrapper passed.
const ECHO_ARGV = `process.stdout.write(JSON.stringify(process.argv.slice(2)));\n`;

try {
  // ── DELEGATION: the wrapper hands Bill's project identity to the master, which spawns the in-tree script ──
  const good = makeVault("good", ECHO_ARGV);
  const resGood = resolveVaultScript(good);
  check("resolveVaultScript (re-exported from master) resolves a valid vault → {vault,script}",
    !!resGood && resGood.script.startsWith(join(good, "scripts")));
  withVault(good, () => {
    let argv: string[] = [];
    try { argv = JSON.parse(loadAibrainContext("hello-desc")); } catch { /* argv stays [] → fails below */ }
    const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
    check("delegation → master spawns the in-tree script with Bill's identity (project/role/sensitivity + description)",
      flag("--project") === "bull" &&
      flag("--role") === "restricted-specialist" &&
      flag("--sensitivity") === "restricted" &&
      flag("--surface") === "fleet-runtime" &&
      flag("--max-evidence") === "3" &&
      flag("--description") === "hello-desc");
  });

  // ── AIBRAIN_CONTEXT=off short-circuits in the master before any resolution/exec ──
  withVault(good, () => {
    const prev = process.env.AIBRAIN_CONTEXT; process.env.AIBRAIN_CONTEXT = "off";
    try { check("AIBRAIN_CONTEXT=off → '' (no exec)", loadAibrainContext("x") === ""); }
    finally { if (prev === undefined) delete process.env.AIBRAIN_CONTEXT; else process.env.AIBRAIN_CONTEXT = prev; }
  });

  // ── STRUCTURAL rejections (all via the master) ──
  const missing = join(base, "does-not-exist-vault");
  check("non-existent vault → resolveVaultScript null", resolveVaultScript(missing) === null);
  withVault(missing, () => check("non-existent vault → loadAibrainContext ''", loadAibrainContext("x") === ""));

  const filePath = join(base, "a-file");
  writeFileSync(filePath, "not a dir");
  check("vault is a file → resolveVaultScript null", resolveVaultScript(filePath) === null);

  const emptyDir = join(base, "empty");
  mkdirSync(emptyDir, { recursive: true });
  check("dir without the context script → resolveVaultScript null", resolveVaultScript(emptyDir) === null);

  // ── CONTAINMENT: an out-of-tree render-context.mjs reached via a junction/symlink escape is REJECTED ──
  try {
    const evil = join(base, "evil-target");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "render-context.mjs"), `process.stdout.write("EVIL_EXECUTED");\n`);
    const esc = join(base, "escvault");
    mkdirSync(join(esc, "scripts"), { recursive: true });
    symlinkSync(evil, join(esc, "scripts", "context"), "junction"); // context/ → out-of-tree evil/
    check("symlink/junction escape → resolveVaultScript null (out-of-tree script refused)", resolveVaultScript(esc) === null);
    withVault(esc, () => check("symlink/junction escape → loadAibrainContext '' (EVIL never executed)", loadAibrainContext("x") === ""));
  } catch (e) {
    console.log(`SKIP — junction/symlink escape sub-test (link creation unavailable here): ${String(e instanceof Error ? e.message : e)}`);
  }

  // ── POSIX TRUSTED-PATH GATE: a WORLD-writable script is refused (defeats the attacker-planted-script
  //    bypass). Group-writable is deliberately ALLOWED by the master (fleet git working trees are
  //    group-writable under umask 002 with the user's own single-member group). Skipped on win32, where the
  //    master relies on containment (no uid/permission model). ──
  if (process.platform !== "win32") {
    const ww = makeVault("worldwritable", ECHO_ARGV);
    const wwScript = join(ww, "scripts", "context", "render-context.mjs");
    check("POSIX: trusted-ancestry vault resolves BEFORE loosening perms (control)", resolveVaultScript(ww) !== null);
    chmodSync(wwScript, 0o666); // sets the world-write bit (0o002) → trusted-path gate must now refuse it
    check("POSIX: world-writable script → resolveVaultScript null (trusted-path gate)", resolveVaultScript(ww) === null);
    withVault(ww, () => check("POSIX: world-writable script → loadAibrainContext '' (never spawned)", loadAibrainContext("x") === ""));
  } else {
    console.log("SKIP — POSIX trusted-path gate sub-test (win32: master relies on containment)");
  }
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
