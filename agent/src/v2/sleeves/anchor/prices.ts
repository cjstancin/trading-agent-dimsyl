// Bull v2 — Anchor: price port + the TTM performance-guard math. Prices here are ANALYTICS inputs
// (drift-watch performance guard, rebuild sizing estimates), not reported 13F numbers — but they
// still travel as d9 so ratio math stays exact once the price is pinned. The real adapter wraps the
// v1 Alpaca data client (same keys, no new feed); v1 returns JS numbers, so the boundary rounds to
// 6 dp BEFORE entering d9 space (documented float→decimal edge; beyond 6 dp Alpaca quotes are noise).
import { d9, div9, type D9 } from "../../decimal.js";
import { addDays } from "../../lots.js";
import { latestPrice, getBars } from "../../../alpaca.js";
import type { PricePort } from "./types.js";

/** Broker-float → d9 at the adapter boundary (6 dp, exact string path — no parseFloat re-entry). */
export function numToD9(x: number): D9 {
  if (!Number.isFinite(x)) throw new Error(`prices: non-finite price ${x}`);
  return d9(x.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
}

/** Real adapter over the v1 Alpaca data client. priceOn9 uses a daily-bar window ENDING at the
 *  date key and takes the last close ≤ that day (nearest prior session — weekends/holidays safe). */
export const alpacaPricePort: PricePort = {
  async latestPrice9(symbol: string): Promise<D9 | null> {
    const p = await latestPrice(symbol);
    return p == null ? null : numToD9(p);
  },
  async priceOn9(symbol: string, dateKey: string): Promise<D9 | null> {
    const bars = await getBars(symbol, addDays(dateKey, -10), addDays(dateKey, 1), "1Day", 15);
    let best: number | null = null;
    for (const b of bars) {
      const day = String((b as any).t ?? "").slice(0, 10);
      if (day && day <= dateKey && typeof (b as any).c === "number") best = (b as any).c;
    }
    return best == null ? null : numToD9(best);
  },
};

/** Fixture adapter for offline tests: latest prices + optional dated history, decimal strings. */
export function fixturePrices(latest: Record<string, string>, history: Record<string, Record<string, string>> = {}): PricePort {
  return {
    async latestPrice9(symbol: string): Promise<D9 | null> {
      const p = latest[symbol];
      return p == null ? null : d9(p);
    },
    async priceOn9(symbol: string, dateKey: string): Promise<D9 | null> {
      const h = history[symbol];
      if (!h) return null;
      // Nearest date ≤ dateKey (mirrors the real adapter's prior-session behavior).
      const days = Object.keys(h).filter((day) => day <= dateKey).sort();
      return days.length ? d9(h[days[days.length - 1]]) : null;
    },
  };
}

/** TTM total-price return for one symbol as a d9 fraction, or null when either endpoint price is
 *  missing (the caller treats null as "cannot evaluate" — never as zero). Dividend-blind by design:
 *  the guard compares a basket to SPY the same way, so the omission roughly cancels. */
export async function ttmReturn9(prices: PricePort, symbol: string, asOf: string): Promise<D9 | null> {
  const p1 = await prices.priceOn9(symbol, asOf);
  const p0 = await prices.priceOn9(symbol, addDays(asOf, -365));
  if (p0 == null || p1 == null || p0 === 0n) return null;
  return div9(p1 - p0, p0);
}

/** Performance-guard input: equal-weight TTM return of the manager's PRIOR top-5 basket minus SPY
 *  TTM, in d9 PERCENTAGE POINTS. Null when any member (or SPY) is unpriceable — the drift runner
 *  skips the guard that quarter rather than judging on a partial basket. */
export async function top5TtmVsSpyPp9(
  prices: PricePort, top5Symbols: string[], asOf: string, benchmark = "SPY",
): Promise<D9 | null> {
  if (top5Symbols.length === 0) return null;
  let sum = 0n;
  for (const sym of top5Symbols) {
    const r = await ttmReturn9(prices, sym, asOf);
    if (r == null) return null;
    sum += r;
  }
  const basket = div9(sum, d9(top5Symbols.length));
  const spy = await ttmReturn9(prices, benchmark, asOf);
  if (spy == null) return null;
  return (basket - spy) * 100n; // fraction diff → pp (d9)
}

/** SPY (benchmark) return over one quarter [periodStartQuarterEnd, periodEnd] as a d9 fraction —
 *  the aum-anomaly detector's market adjustment. */
export async function quarterReturn9(prices: PricePort, prevPeriod: string, period: string, benchmark = "SPY"): Promise<D9 | null> {
  const p0 = await prices.priceOn9(benchmark, prevPeriod);
  const p1 = await prices.priceOn9(benchmark, period);
  if (p0 == null || p1 == null || p0 === 0n) return null;
  return div9(p1 - p0, p0);
}
