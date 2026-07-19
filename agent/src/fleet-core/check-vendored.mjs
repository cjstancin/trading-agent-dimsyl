#!/usr/bin/env node
// Verify vendored shared-master copies against the .sync-manifest.json that
// castle/scripts/sync-fleet-core.mjs writes into each vendored dir. Catches the classic mistake:
// editing a vendored copy instead of the castle master. Zero-dep, self-contained — a consuming
// repo's CI can run it with NO access to the castle repo:
//   node src/fleet-core/check-vendored.mjs src/fleet-core src/security-baseline
// Every file listed in a dir's manifest must exist and hash-match (line-ending-normalized, so
// Windows/Linux checkouts agree). Exit 1 on any drift. Cross-repo staleness (a master that moved
// ahead) is caught castle-side by `sync-fleet-core.mjs --check` — not this checker's job.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sha256Normalized = (s) => createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('usage: node check-vendored.mjs <vendored-dir> [<vendored-dir> ...]');
  process.exit(2);
}

let bad = 0;
for (const dir of dirs) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(dir, '.sync-manifest.json'), 'utf8'));
  } catch {
    console.error(`[check-vendored] MISSING manifest in ${dir} — run castle/scripts/sync-fleet-core.mjs`);
    bad++;
    continue;
  }
  for (const [file, want] of Object.entries(manifest.files || {})) {
    try {
      const got = sha256Normalized(await readFile(resolve(dir, file), 'utf8'));
      if (got !== want) {
        console.error(`[check-vendored] DRIFT   ${dir}/${file} — vendored copy differs; edit the castle master + re-sync`);
        bad++;
      } else {
        console.log(`[check-vendored] ok      ${dir}/${file}`);
      }
    } catch {
      console.error(`[check-vendored] MISSING ${dir}/${file}`);
      bad++;
    }
  }
}
process.exit(bad ? 1 : 0);
