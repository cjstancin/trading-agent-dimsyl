// Tests for the profit-trim pure helpers (no network). Run: npm run test:profit-trim
import { findWinners, parseTrims } from "./profit-trim.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// findWinners: only positions at/above the trigger, with qty > 0.
{
  const pos = [
    { symbol: "AAA", avg_entry_price: 100, current_price: 120, unrealized_plpc: 0.20, qty: 1 },     // +20% → winner
    { symbol: "BBB", avg_entry_price: 100, current_price: 108, unrealized_plpc: 0.08, qty: 1 },     // +8% → below trigger
    { symbol: "CCC", avg_entry_price: 100, current_price: 130, unrealized_plpc: 0.30, qty: 0 },     // +30% but zero qty
  ];
  const w = findWinners(pos, 15);
  check("findWinners: only gains ≥ trigger with qty>0", w.length === 1 && w[0].symbol === "AAA" && w[0].gainPct === 20);
}

// parseTrims: parse + uppercase + clamp fraction to [0,1]; drop rows without a numeric trimFraction.
{
  const t = parseTrims('[{"symbol":"nvda","trimFraction":0.5,"reason":"half"},{"symbol":"MU","trimFraction":1.4,"reason":"all"},{"symbol":"BAD"}]');
  check("parseTrims: parses, uppercases, clamps to 1", t.length === 2 && t[0].symbol === "NVDA" && t[1].trimFraction === 1);
  check("parseTrims: drops rows missing a numeric trimFraction", !t.some((x) => x.symbol === "BAD"));
}

// parseTrims: junk / no array → [].
check("parseTrims: junk → []", parseTrims("no json here").length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
