// Bull v2 — Wildcard pick count + sizing (design §6). Top 2–3 EQUAL-SIZED buys; the count is an
// equity-indexed schedule (living-design rule: code reads live equity, growth needs no amendment)
// and the LEI regime dial scales NEW-BUY sizing via deployScalar (book layer supplies 1.0 / 0.7 /
// 0.55; the dial applies to Momentum + Wildcard only — design §2).
//
// The count schedule is DERIVED entirely from committed config, no local constants:
//   baseline sleeve  = book.equityUsd × book.sleeveSplit.wld            ($500 at defaults)
//   baseline per-pick = baseline sleeve ÷ wildcard.picks.count          ($250 at defaults)
//   count            = clamp(floor(sleeveUsd ÷ baseline per-pick), picks.count, picks.countMax)
// At defaults: $500 → 2 picks ($250 each), ≥$750 → 3 (capped at countMax), matching the design's
// "$165–250 each at $500; count scales with sleeve equity".
import { d9, div9, mul9, type D9 } from "../../decimal.js";

/** How many concurrent picks the sleeve should hold at this equity. Pure config math. */
export function pickCount(cfg: any, sleeveUsd: number): number {
  const wld = cfg.wildcard;
  const baselineSleeve = Number(cfg.book.equityUsd) * Number(cfg.book.sleeveSplit.wld);
  const perPickBaseline = baselineSleeve / Number(wld.picks.count);
  const raw = Math.floor(sleeveUsd / perPickBaseline);
  return Math.min(Number(wld.picks.countMax), Math.max(Number(wld.picks.count), raw));
}

/** Equal-split notional for ONE new buy: (sleeve equity ÷ count) × deployScalar. All d9 — the
 *  scalar goes through d9's exact string parse, never float multiplication on money. */
export function perBuyNotional9(sleeveEquity9: D9, count: number, deployScalar: number): D9 {
  if (!Number.isInteger(count) || count < 1) throw new Error(`perBuyNotional9: bad count ${count}`);
  if (!(deployScalar > 0) || deployScalar > 1) throw new Error(`perBuyNotional9: deployScalar ${deployScalar} out of (0,1]`);
  return mul9(div9(sleeveEquity9, d9(BigInt(count))), d9(String(deployScalar)));
}
