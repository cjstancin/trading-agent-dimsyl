// Loads .env into process.env, OVERRIDING any pre-existing (often STALE Windows) values so the .env file
// is the single source of truth for keys. MUST be imported FIRST by every entry script — before alpaca.js
// or agent.js read process.env. Order: repo-root .env first, then agent/.env LAST (agent/.env wins).
// Why override: `tsx` inherits Windows env vars; a stale ALPACA_API_KEY there silently beats the .env edit.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = [
  fileURLToPath(new URL("../../.env", import.meta.url)), // Projects/Trading-Agent/.env  (root)
  fileURLToPath(new URL("../.env", import.meta.url)),    // Projects/Trading-Agent/agent/.env  (wins)
];

let loaded = 0;
for (const f of FILES) {
  if (!existsSync(f)) continue;
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[key] = val; // OVERRIDE — .env beats stale shell/Windows env
  }
  loaded++;
}

// One-line, secret-free confirmation of which config is actually live (helps debug key mix-ups instantly).
if (loaded && process.env.ALPACA_API_KEY) {
  const k = process.env.ALPACA_API_KEY;
  console.error(`[env] loaded ${loaded} .env file(s) · ALPACA key ${k.slice(0, 4)}… ${k.startsWith("PK") ? "(paper ✓)" : "(⚠ NON-paper prefix — paper keys start with PK)"} · base ${process.env.ALPACA_BASE_URL || "(default paper-api)"}`);
}
