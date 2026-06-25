// Tests for the synthetic trailing-stop core (no network). Run: npm run test:synthetic-stops
import { evaluateStops } from "./synthetic-stops.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// First sighting: peak seeds at price; flat at peak → no breach.
{
  const { breaches, next } = evaluateStops([{ symbol: "AAA", price: 100, entry: 100, qty: 1 }], {}, 20);
  check("seed peak = price, no breach at peak", next.AAA.peak === 100 && breaches.length === 0);
}
// Breach: 25% below peak with a 20% trail (fractional qty).
{
  const { breaches } = evaluateStops([{ symbol: "BBB", price: 75, entry: 100, qty: 0.5 }], { BBB: { peak: 100 } }, 20);
  check("breach when ≥20% below peak", breaches.length === 1 && breaches[0].symbol === "BBB");
}
// No breach: only 10% below peak.
{
  const { breaches } = evaluateStops([{ symbol: "CCC", price: 90, entry: 100, qty: 1 }], { CCC: { peak: 100 } }, 20);
  check("no breach when above the stop", breaches.length === 0);
}
// Peak trails UP with a new high.
{
  const { next } = evaluateStops([{ symbol: "DDD", price: 130, entry: 100, qty: 1 }], { DDD: { peak: 110 } }, 20);
  check("peak trails up to the new high", next.DDD.peak === 130);
}
// TRAILING: stop measures from the PEAK (130), not entry (100). 103 is +3% on entry but −20.8% off peak → breach.
{
  const { breaches } = evaluateStops([{ symbol: "EEE", price: 103, entry: 100, qty: 1 }], { EEE: { peak: 130 } }, 20);
  check("trailing stop fires from the peak, not entry", breaches.length === 1);
}
// Closed names are pruned from the state (not in the current positions).
{
  const { next } = evaluateStops([{ symbol: "FFF", price: 100, entry: 100, qty: 1 }], { GONE: { peak: 200 } }, 20);
  check("closed name pruned from state", next.GONE === undefined && next.FFF !== undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
