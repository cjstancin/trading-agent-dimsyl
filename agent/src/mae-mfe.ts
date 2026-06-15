// MAE / MFE excursion math (Bull backlog #12) — PURE, no network. Given a closed trade's entry price,
// its side, and the price bars spanning the hold window, compute the Maximum Adverse Excursion (worst
// the position got) and Maximum Favorable Excursion (best it got), each as a per-share $ move and a %
// of entry. Bars are fetched elsewhere (alpaca.getBars) and handed in — this module never does I/O, so
// it is trivially unit-testable. Sign convention: MAE ≤ 0 and MFE ≥ 0 when the window straddles entry;
// on a gap that never traded against the position the adverse extreme can itself be favorable, so MAE
// can be > 0 — we report the literal entry→extreme move (not a clamped value) to stay informative.
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export type Side = "long" | "short";

/** Minimal price-bar shape MAE/MFE needs: a high and a low. Alpaca bars ({t,o,h,l,c,v}) satisfy this structurally. */
export interface PriceBar { h: number; l: number; }

export interface Excursion { maePct: number; maeUsd: number; mfePct: number; mfeUsd: number; }

/**
 * Compute MAE/MFE for one closed trade from already-fetched bars.
 *   - long:  adverse = entry→lowest low,   favorable = entry→highest high
 *   - short: adverse = entry→highest high,  favorable = entry→lowest low
 * Returns zeros when there are no usable bars or entry ≤ 0 (no data → no excursion).
 */
export function maeMfe(entry: number, side: Side, bars: PriceBar[]): Excursion {
  const e = num(entry);
  const highs: number[] = [];
  const lows: number[] = [];
  for (const b of bars ?? []) {
    const h = num(b?.h), l = num(b?.l);
    if (h > 0) highs.push(h);
    if (l > 0) lows.push(l);
  }
  if (e <= 0 || !highs.length || !lows.length) return { maePct: 0, maeUsd: 0, mfePct: 0, mfeUsd: 0 };
  const lowL = Math.min(...lows);
  const highH = Math.max(...highs);
  // Per-share dollar excursion, signed by the direction of the position.
  const maeUsd = side === "short" ? e - highH : lowL - e;   // adverse  (≤ 0 when price moved against)
  const mfeUsd = side === "short" ? e - lowL : highH - e;    // favorable (≥ 0 when price moved in favor)
  return {
    maePct: round((maeUsd / e) * 100, 2),
    maeUsd: round(maeUsd, 2),
    mfePct: round((mfeUsd / e) * 100, 2),
    mfeUsd: round(mfeUsd, 2),
  };
}
