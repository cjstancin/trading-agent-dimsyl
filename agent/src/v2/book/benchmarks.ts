// Bull v2 — benchmarks + gate progress (design §8). Headline: book TOTAL RETURN vs SPY total
// return, dividends included on BOTH sides (the book self-credits dividends in the cash ledger;
// SPY TR comes from adjusted closes). Per-sleeve fair rivals: Momentum vs QMOM (+ its N=50 shadow),
// Insider vs IWM (+ its all-signals shadow), Anchor vs SPY and NANC, Wildcard vs an equal-weight
// basket of what the other three sleeves held. Gate (CJ-locked): rolling 12-mo book TR vs SPY TR
// AND realized max DD ≤ 15% — 12 months green before any live-flip talk.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "./../decimal.js";
import { equityCurve, realizedMaxDrawdownPct } from "./equity.js";

export function ensureBenchTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bench_marks (
      date TEXT NOT NULL,
      series TEXT NOT NULL,            -- 'SPY' | 'QMOM' | 'IWM' | 'NANC' | 'wld-rival-basket' | sleeve equity series 'sleeve:mom' …
      value9 TEXT NOT NULL,            -- adjusted close (TR proxy) or sleeve equity mark
      PRIMARY KEY (date, series)
    );
  `);
}

export function recordBench(db: DatabaseSync, date: string, series: string, value9: D9): void {
  ensureBenchTables(db);
  db.prepare("INSERT INTO bench_marks(date, series, value9) VALUES(?,?,?) ON CONFLICT(date, series) DO UPDATE SET value9=excluded.value9")
    .run(date, series, d9str(value9));
}

export function benchSeries(db: DatabaseSync, series: string): { date: string; value9: D9 }[] {
  ensureBenchTables(db);
  const rows = db.prepare("SELECT date, value9 FROM bench_marks WHERE series=? ORDER BY date ASC").all(series) as any[];
  return rows.map((r) => ({ date: r.date, value9: d9(r.value9) }));
}

/** Total return over a window from a value series (first→last), as a fraction (0.1 = +10%).
 *  Display-precision floats are fine here — nothing feeds back into ledger math. */
export function totalReturn(series: { date: string; value9: D9 }[], fromDate?: string): number | null {
  const rows = fromDate ? series.filter((r) => r.date >= fromDate) : series;
  if (rows.length < 2) return null;
  const a = Number(rows[0].value9);
  const b = Number(rows[rows.length - 1].value9);
  if (a <= 0) return null;
  return b / a - 1;
}

export interface GateProgress {
  windowStart: string | null;
  monthsCovered: number;          // how much of the 12-month window the curve covers so far
  bookTR: number | null;          // rolling window total return
  spyTR: number | null;
  beatingSpy: boolean | null;
  realizedMaxDDPct: number;
  ddWithinCeiling: boolean;
  green: boolean;                 // both legs green over a FULL 12-month window
}

/** Gate progress vs the CJ-locked live gate. Honest about partial windows: green requires a full
 *  12 months of curve, not a hot first quarter. */
export function gateProgress(db: DatabaseSync, opts: { asOfDate: string; ddCeilingPct: number }): GateProgress {
  const curve = equityCurve(db);
  const windowStart = curve.length ? isoMonthsBack(opts.asOfDate, 12) : null;
  const bookWindow = curve.filter((m) => windowStart === null || m.date >= windowStart).map((m) => ({ date: m.date, value9: m.equity9 }));
  const spy = benchSeries(db, "SPY");
  const spyWindow = windowStart ? spy.filter((r) => r.date >= windowStart) : spy;

  const monthsCovered = bookWindow.length >= 2
    ? Math.min(12, Math.round((new Date(bookWindow[bookWindow.length - 1].date).getTime() - new Date(bookWindow[0].date).getTime()) / (30.44 * 86_400_000)))
    : 0;
  const bookTR = totalReturn(bookWindow);
  const spyTR = totalReturn(spyWindow);
  const beating = bookTR != null && spyTR != null ? bookTR > spyTR : null;
  const dd = realizedMaxDrawdownPct(db);
  const ddOk = dd <= opts.ddCeilingPct;
  return {
    windowStart,
    monthsCovered,
    bookTR,
    spyTR,
    beatingSpy: beating,
    realizedMaxDDPct: dd,
    ddWithinCeiling: ddOk,
    green: monthsCovered >= 12 && beating === true && ddOk,
  };
}

function isoMonthsBack(dateKey: string, months: number): string {
  const d = new Date(dateKey + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Wildcard's fair rival: equal-weight basket of the OTHER three sleeves' current holdings —
 *  "did concentration add anything?" Pure: returns per-symbol weights. */
export function wildcardRivalBasket(holdings: { sleeve: string; symbol: string }[]): Map<string, number> {
  const symbols = [...new Set(holdings.filter((h) => h.sleeve !== "wld" && h.sleeve !== "book").map((h) => h.symbol))].sort();
  const w = symbols.length ? 1 / symbols.length : 0;
  return new Map(symbols.map((s) => [s, w]));
}
