// Bull v2 — book equity marks + day-trade guard (design §2). Equity = internal total cash + Σ
// position × price (SGOV INCLUDED — the brake measures the whole book). Daily marks persist in a
// book-private table so the equity curve, drawdown, and gate progress are computed from OUR ledger
// (design §7: internal ledger = performance truth), never from Alpaca's portfolio-history endpoint.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, type D9 } from "./../decimal.js";
import { totalCash } from "./../settled-cash.js";
import { ledgerPositions } from "./../lots.js";

export function ensureBookTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_marks (
      date TEXT PRIMARY KEY,          -- ET trading date
      equity9 TEXT NOT NULL,
      cash9 TEXT NOT NULL,
      positions_json TEXT NOT NULL,   -- [{symbol, qty9, price9, value9, sleeves:[..]}]
      dial TEXT,                      -- dial position that day (digest/curve annotation)
      brake_tier INTEGER,
      created_ts TEXT NOT NULL
    );
  `);
}

export interface EquityMark {
  date: string;
  equity9: D9;
  cash9: D9;
  positions: { symbol: string; qty9: string; price9: string; value9: string }[];
  missingPrices: string[]; // symbols we hold but got no price for — mark still writes, flagged
}

/** Compute (and idempotently persist) the day's equity mark from ledger positions × given prices.
 *  A missing price falls back to the previous mark's price for that symbol (flagged) — a data
 *  outage must not fabricate a drawdown. */
export function markEquity(db: DatabaseSync, date: string, prices: Map<string, D9>, extra: {
  dial?: string; brakeTier?: number;
} = {}): EquityMark {
  ensureBookTables(db);
  const cash = totalCash(db);
  const held = ledgerPositions(db);
  const prevRow = db.prepare("SELECT positions_json FROM book_marks WHERE date < ? ORDER BY date DESC LIMIT 1").get(date) as
    | { positions_json: string } | undefined;
  const prevPrices = new Map<string, D9>();
  if (prevRow) for (const p of JSON.parse(prevRow.positions_json) as any[]) prevPrices.set(p.symbol, d9(p.price9));

  const positions: EquityMark["positions"] = [];
  const missing: string[] = [];
  let value = 0n;
  for (const [symbol, qty] of [...held.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let px = prices.get(symbol);
    if (px == null) {
      const prev = prevPrices.get(symbol);
      if (prev == null) { missing.push(symbol); continue; }
      px = prev;
      missing.push(symbol);
    }
    const v = mul9(qty, px);
    value += v;
    positions.push({ symbol, qty9: d9str(qty), price9: d9str(px), value9: d9str(v) });
  }
  const equity = cash + value;
  db.prepare(
    `INSERT INTO book_marks(date, equity9, cash9, positions_json, dial, brake_tier, created_ts)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET equity9=excluded.equity9, cash9=excluded.cash9,
       positions_json=excluded.positions_json, dial=excluded.dial, brake_tier=excluded.brake_tier`,
  ).run(date, d9str(equity), d9str(cash), JSON.stringify(positions), extra.dial ?? null, extra.brakeTier ?? null, new Date().toISOString());
  return { date, equity9: equity, cash9: cash, positions, missingPrices: missing };
}

/** Equity curve rows ascending (for drawdown, gate progress, dashboard). */
export function equityCurve(db: DatabaseSync): { date: string; equity9: D9; dial: string | null; brakeTier: number | null }[] {
  ensureBookTables(db);
  const rows = db.prepare("SELECT date, equity9, dial, brake_tier FROM book_marks ORDER BY date ASC").all() as any[];
  return rows.map((r) => ({ date: r.date, equity9: d9(r.equity9), dial: r.dial, brakeTier: r.brake_tier }));
}

/** Realized max drawdown (%) over the stored curve — the number the live gate holds against 15. */
export function realizedMaxDrawdownPct(db: DatabaseSync): number {
  let peak = 0n;
  let maxDd = 0;
  for (const m of equityCurve(db)) {
    if (m.equity9 > peak) peak = m.equity9;
    if (peak > 0n) {
      const dd = Number(((peak - m.equity9) * 10_000n) / peak) / 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

// ---------------------------------------------------------------------------------------------
// Day-trade guard (design §2): all sleeves are swing-cadence, so a same-day round trip should
// never happen — this counter blocks the 4th day-trade in 5 rolling trading days as belt-and-
// suspenders. A "day trade" = buy and sell of the SAME symbol on the SAME ET date. The guard runs
// as a gateway extraGuard: it refuses the CLOSING leg that would create day-trade #4.
// ---------------------------------------------------------------------------------------------

/** Count completed day-trades in the rolling window of the last 5 ET dates present in fills. */
export function dayTradeCount(db: DatabaseSync, asOfDate: string, windowDays = 5): number {
  const rows = db
    .prepare("SELECT symbol, side, substr(ts,1,10) AS d FROM fills WHERE substr(ts,1,10) <= ? ORDER BY d DESC")
    .all(asOfDate) as { symbol: string; side: string; d: string }[];
  const dates = [...new Set(rows.map((r) => r.d))].slice(0, windowDays);
  const win = new Set(dates);
  let count = 0;
  const bySymbolDate = new Map<string, { buys: number; sells: number }>();
  for (const r of rows) {
    if (!win.has(r.d)) continue;
    const k = `${r.symbol}:${r.d}`;
    const e = bySymbolDate.get(k) ?? { buys: 0, sells: 0 };
    if (r.side === "buy") e.buys++; else e.sells++;
    bySymbolDate.set(k, e);
  }
  for (const e of bySymbolDate.values()) count += Math.min(e.buys, e.sells);
  return count;
}

/** Would placing `side` on `symbol` today complete a same-day round trip? */
export function wouldCompleteRoundTrip(db: DatabaseSync, symbol: string, side: "buy" | "sell", asOfDate: string): boolean {
  const opposite = side === "buy" ? "sell" : "buy";
  const row = db
    .prepare("SELECT id FROM fills WHERE symbol=? AND side=? AND substr(ts,1,10)=? LIMIT 1")
    .get(symbol.toUpperCase(), opposite, asOfDate);
  return !!row;
}

/** Gateway extraGuard factory: refuse the order that would be day-trade #(max+1). */
export function dayTradeGuard(maxPer5Days: number) {
  return (db: DatabaseSync, req: { symbol: string; side: "buy" | "sell"; asOfDate: string }): { skip: "DAY_TRADE_GUARD"; detail: string } | null => {
    if (!wouldCompleteRoundTrip(db, req.symbol, req.side, req.asOfDate)) return null;
    const n = dayTradeCount(db, req.asOfDate);
    if (n >= maxPer5Days) return { skip: "DAY_TRADE_GUARD", detail: `${n} day-trades in window; this order would round-trip ${req.symbol}` };
    return null;
  };
}
