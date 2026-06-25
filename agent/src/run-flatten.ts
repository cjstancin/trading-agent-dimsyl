// Manual FLATTEN: close EVERY open paper position at market + clear the synthetic-stop and per-position-trail
// state, so a fresh strategy build starts from a clean slate (all cash). Run: npm run flatten
// Paper-only (alpaca.ts hard-guards the paper host). Used once for the Phase-1 risk-engine cutover.
import "./load-env.js";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paperSnapshot, closePosition } from "./alpaca.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-flatten");

const snap = await paperSnapshot();
if (!snap.connected) { console.error(JSON.stringify({ ok: false, reason: "Alpaca not connected", error: snap.error })); process.exit(1); }

const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Array<Record<string, unknown>>;
const closed: string[] = [];
for (const p of positions) {
  const sym = String(p.symbol);
  try { await closePosition(sym); closed.push(sym); } catch (e) { closed.push(`${sym} FAILED: ${String(e instanceof Error ? e.message : e)}`); }
}
// wipe the protective-stop state so the new engine seeds clean per-position trails on its first buys
for (const f of ["../../memory/stops.json", "../../memory/position-trails.json"]) {
  try { unlinkSync(fileURLToPath(new URL(f, import.meta.url))); } catch { /* may not exist */ }
}
console.log(JSON.stringify({ ok: true, closedCount: positions.length, closed }, null, 2));
