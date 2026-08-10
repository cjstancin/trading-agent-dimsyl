// Bull v2 insider sleeve — liquidity floor + spread gate (design: 21-day median dollar volume
// ≥ $300k · price ≥ $2 · market cap ≥ $75M · exchange-listed · spread ≤ 1.5% of mid, checked at
// DECISION and again AT OPEN). Insider clusters skew microcap — this floor is what keeps a paper
// fill from pretending we could actually trade the name. Everything fails CLOSED: missing bars,
// missing market cap, missing quote → not fundable (the shadow book still records the signal, so
// nothing is lost scientifically — we just don't book fantasy fills).
// All comparisons in d9; thresholds arrive from config (insider.liquidity) — never hardcoded.
import { d9, div9, type D9 } from "../../decimal.js";
import type { DailyBar } from "./ports.js";

export interface LiquidityCfg {
  minMedianDollarVol21dUsd: number;
  minPrice: number;
  minMarketCapUsd: number;
  maxSpreadPct: number;
}

// The design's "21-day median" — a lookback length, not a tunable (config holds the $ floor).
export const MEDIAN_LOOKBACK_DAYS = 21;

/** Median daily dollar volume (close × volume) over the trailing `n` bars. d9 exact; the median of
 *  an even count takes the LOWER middle (conservative — biases toward failing the floor). */
export function medianDollarVolume9(bars: DailyBar[], n: number = MEDIAN_LOOKBACK_DAYS): D9 | null {
  if (bars.length < n) return null; // not enough history → caller fails closed
  const recent = bars.slice(-n).map((b) => {
    // close × volume without the ×1e9 blowup: volume is a whole-share count, so scale it down first.
    return (b.close9 * b.volume9) / 10n ** 9n;
  });
  recent.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return recent[Math.floor((recent.length - 1) / 2)];
}

/** Spread gate: (ask − bid) / mid ≤ maxSpreadPct%. A crossed or zero quote fails (garbage in →
 *  no trade out). Pure so the same check runs at decision time AND at the open. */
export function spreadOk(bid9: D9, ask9: D9, maxSpreadPct: number): boolean {
  if (bid9 <= 0n || ask9 <= 0n || ask9 < bid9) return false;
  const mid9 = (bid9 + ask9) / 2n;
  if (mid9 <= 0n) return false;
  const ratio = div9(ask9 - bid9, mid9);                    // fraction, d9
  const cap = div9(d9(maxSpreadPct), d9("100"));            // pct → fraction
  return ratio <= cap;
}

export interface LiquidityInputs {
  bars: DailyBar[];            // trailing daily bars, ascending
  price9: D9 | null;           // decision price (quote mid preferred, else last close)
  marketCap9: D9 | null;       // null = unverifiable → fail
  exchange: string | null;     // Alpaca exchange code; null/OTC → fail
}

export type LiquidityVerdict = { ok: true } | { ok: false; reason: string };

/** The full floor. Returns the FIRST failing gate as the reason (audit trail favors specificity
 *  over completeness — the shadow book records it verbatim). */
export function passesLiquidityFloor(inp: LiquidityInputs, cfg: LiquidityCfg): LiquidityVerdict {
  const med = medianDollarVolume9(inp.bars);
  if (med === null) return { ok: false, reason: "LIQUIDITY_BARS_SHORT" };
  if (med < d9(cfg.minMedianDollarVol21dUsd)) return { ok: false, reason: "LIQUIDITY_DOLLAR_VOL" };
  if (inp.price9 === null || inp.price9 < d9(cfg.minPrice)) return { ok: false, reason: "LIQUIDITY_PRICE" };
  if (inp.marketCap9 === null || inp.marketCap9 < d9(cfg.minMarketCapUsd)) return { ok: false, reason: "LIQUIDITY_MARKET_CAP" };
  if (!inp.exchange || /^OTC$/i.test(inp.exchange)) return { ok: false, reason: "LIQUIDITY_NOT_LISTED" };
  return { ok: true };
}
