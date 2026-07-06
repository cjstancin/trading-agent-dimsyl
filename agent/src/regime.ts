// Deterministic 200-DMA market regime — activates risk-engine's dormant regimeOn() in LIVE code (it
// was previously exercised only by the backtest; the dashboard "regime" pill was an LLM vibe / static
// string). SPY daily closes come from the same Yahoo chart feed stats.ts already uses; no new source.
//
//   risk-on  : SPY ≥ its 200-DMA AND the 200-DMA is rising    → deploy normally
//   risk-off : SPY <  its 200-DMA AND the 200-DMA is falling  → CONFIRMED downtrend; block NEW longs
//   neutral  : mixed signals, or not enough data / feed down  → fail-OPEN, never blocks
//
// The regime gate is enforced in run-execute (deterministic, pre-sizing): in confirmed risk-off, a NEW
// long entry is dropped unless its setup is explicitly counter-trend-tagged, or BULL_IGNORE_REGIME=1 is
// set for a deliberate play. Sizing is untouched — this only filters WHICH names may open.
import { regimeOn } from "./risk-engine.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";

export type RegimeState = "risk-on" | "risk-off" | "neutral";

export interface Regime {
  state: RegimeState;
  price: number | null;   // latest SPY close (null when unknown)
  ma200: number | null;   // 200-DMA (null when not computable)
  slopeUp: boolean | null; // 200-DMA today vs SLOPE_LOOKBACK sessions ago (null when not computable)
  asOf: string;            // ISO timestamp of the computation
}

/** Sessions back to compare the 200-DMA against for its slope (~1 trading month). */
export const SLOPE_LOOKBACK = 20;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Neutral fail-open regime (feed down / not enough history) — never blocks anything. */
export function neutralRegime(asOf = new Date().toISOString()): Regime {
  return { state: "neutral", price: null, ma200: null, slopeUp: null, asOf };
}

/**
 * PURE regime classification from ascending daily closes (SPY). Needs 200 + SLOPE_LOOKBACK closes to
 * judge both level and slope; anything less → neutral (fail-open, mirrors regimeOn's unknown-MA→on).
 */
export function computeRegime(closes: number[], asOf = new Date().toISOString()): Regime {
  const cl = (closes ?? []).filter((x) => Number.isFinite(x) && x > 0);
  if (cl.length < 200 + SLOPE_LOOKBACK) return neutralRegime(asOf);
  const maEndingAt = (end: number) => cl.slice(end - 200, end).reduce((s, x) => s + x, 0) / 200;
  const price = cl[cl.length - 1];
  const maNow = maEndingAt(cl.length);
  const maPrev = maEndingAt(cl.length - SLOPE_LOOKBACK);
  const above = regimeOn(price, maNow); // the risk-engine primitive, now actually driving live decisions
  const slopeUp = maNow >= maPrev;
  const state: RegimeState = above && slopeUp ? "risk-on" : !above && !slopeUp ? "risk-off" : "neutral";
  return { state, price: r2(price), ma200: r2(maNow), slopeUp, asOf };
}

/** SPY regime from the Yahoo chart feed (2y daily → ~500 closes, enough for MA200 + slope).
 *  Best-effort: any failure → neutral (fail-open), so a feed outage never blocks trading. */
export async function fetchSpyRegime(): Promise<Regime> {
  try {
    const r = await withTimeout(
      (signal) => fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=2y&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (compatible; Bull/1.0)" }, signal }),
      DEFAULT_TIMEOUT_MS,
    );
    if (!r.ok) return neutralRegime();
    const j = await r.json();
    const closes = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((x: number | null) => x != null && x > 0) as number[];
    return computeRegime(closes);
  } catch { return neutralRegime(); }
}

/** BULL_IGNORE_REGIME=1 → skip the regime gate for a deliberate play. */
export function ignoreRegime(env: Record<string, string | undefined> = process.env): boolean {
  return env.BULL_IGNORE_REGIME === "1";
}

// A setup is exempt from the risk-off block only when EXPLICITLY counter-trend-tagged.
const COUNTER_TREND = /counter[\s-]?trend/i;

/**
 * Reason to block a NEW long entry under the current regime, or null to allow. PURE. Blocks only:
 * buy orders, in a CONFIRMED risk-off regime, whose setup is not explicitly counter-trend-tagged,
 * when the override isn't set. Sells / exits are never touched — stops keep protecting positions.
 */
export function regimeBlockReason(order: { side: string; setup?: string | null }, regime: Regime, ignore = false): string | null {
  if (ignore || regime.state !== "risk-off" || order.side !== "buy") return null;
  if (order.setup && COUNTER_TREND.test(order.setup)) return null;
  return `regime risk-off (SPY $${regime.price} below falling 200-DMA $${regime.ma200}) — new longs blocked unless setup is tagged "counter-trend" (BULL_IGNORE_REGIME=1 overrides)`;
}

/** One-line human rendering for the premarket brief / scan prompt / logs. */
export function renderRegimeLine(r: Regime): string {
  if (r.price == null || r.ma200 == null) return "neutral — SPY 200-DMA unavailable (fail-open: no blocking)";
  return `${r.state} — SPY $${r.price} ${r.price >= r.ma200 ? "above" : "below"} its ${r.slopeUp ? "rising" : "falling"} 200-DMA ($${r.ma200})`;
}

/** Dashboard pill string ("Risk-on" / "Risk-off" / "Neutral") — replaces the old static/LLM-vibe value. */
export function regimePill(r: Regime): string {
  return r.state === "risk-on" ? "Risk-on" : r.state === "risk-off" ? "Risk-off" : "Neutral";
}
