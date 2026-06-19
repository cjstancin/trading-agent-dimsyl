// Daily equity-curve series builder — PURE, no network, read-only over Alpaca portfolio history.
// Where stats.ts emits the bare `equityCurve: number[]` the You-vs-SPY overlay rebases to 100, this emits a
// richer DATED series — one point per trading day with the equity value AND that day's P&L — so the
// dashboard can chart the curve with real dates and day-over-day moves. It derives from the SAME portfolio
// history measure() already fetches (no extra request) and never touches orders or any live path, so it is
// trivially unit-testable.
//
// dayPnl is the day-over-day equity delta (equity[i] − equity[i−1], first day 0). On a paper account with no
// deposits/withdrawals this equals the day's realized+unrealized P&L, and by construction the dayPnl values
// sum to the window's total equity change — internally consistent for charting.
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };

/** One charted day on the equity curve. */
export interface EquityPoint {
  date: string;   // YYYY-MM-DD (UTC), derived from the Alpaca period timestamp
  equity: number; // account equity at end of that period
  dayPnl: number; // equity[i] − equity[i−1]; 0 for the first point
}

/** The slice of Alpaca's portfolio-history payload this builder reads (a structural subset). */
export interface PortfolioHistory {
  timestamp?: (number | null)[]; // epoch SECONDS, one per period
  equity?: (number | null)[];    // account equity, one per period
}

/**
 * Build a daily equity-curve series from Alpaca portfolio history. Pure and deterministic: the dates come
 * only from the input timestamps (no clock read). Pairs the timestamp/equity arrays by index, keeps points
 * with a valid timestamp AND a positive equity, collapses duplicate dates (keeping the last equity that
 * day), sorts ascending by date, then fills in each day's P&L. Returns [] when there's nothing usable.
 */
export function buildEquityCurve(ph: PortfolioHistory | null | undefined): EquityPoint[] {
  const ts = Array.isArray(ph?.timestamp) ? ph!.timestamp! : [];
  const eq = Array.isArray(ph?.equity) ? ph!.equity! : [];
  const n = Math.min(ts.length, eq.length);

  // date → equity, later index wins (collapses any duplicate days to that day's last reading)
  const byDate = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const sec = num(ts[i]);
    const equity = num(eq[i]);
    if (sec <= 0 || equity <= 0) continue;
    const date = new Date(sec * 1000).toISOString().slice(0, 10);
    byDate.set(date, r2(equity));
  }

  const dates = [...byDate.keys()].sort();
  let prev: number | null = null;
  return dates.map((date) => {
    const equity = byDate.get(date)!;
    const dayPnl = prev === null ? 0 : r2(equity - prev);
    prev = equity;
    return { date, equity, dayPnl };
  });
}
