// Bull v2 insider sleeve — shadow book (design §evaluation). EVERY qualifying cluster signal gets
// a row here, funded or not, and accrues 21/63/126-trading-day CARs vs the sleeve benchmark (IWM,
// from config benchmarks.ins). Rationale, verbatim from the design: 40–100+ observations/yr vs
// 4–8 funded round trips — the shadow book is the honest evaluator; year-1 P&L cannot validate
// this sleeve. Skips (full slots, liquidity, spread, not-fractionable, gateway refusals) are
// recorded with their reason so the funded book's selection bias is measurable, not invisible.
//
// CAR convention: entry session = day 0 (entry price is the recorded next-open reference), horizon
// day N = the close N trading sessions after the entry session. CAR_N = (sym_N/sym_0 − 1) −
// (bench_N/bench_0 − 1). Stored as floats — CARs are analytics, never money math.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9num, d9str, type D9 } from "../../decimal.js";
import type { Cluster } from "./cluster.js";
import type { PricePort } from "./ports.js";

export const CAR_HORIZONS = [21, 63, 126] as const;

/** Record a qualifying signal (idempotent by cluster_id — re-detection of the same cluster must
 *  not double-count an observation). Returns true when a NEW row was created. */
export function recordSignal(db: DatabaseSync, c: Cluster, signalDate: string): boolean {
  const res = db.prepare(
    `INSERT INTO ins_signals(cluster_id, symbol, signal_date, score, funded, created_ts)
     VALUES(?,?,?,?,0,?)
     ON CONFLICT(cluster_id) DO NOTHING`,
  ).run(c.clusterId, c.symbol, signalDate, c.score, new Date().toISOString());
  return Number(res.changes) > 0;
}

export function markFunded(db: DatabaseSync, clusterId: string, opts: {
  entryDate: string; slotNotional9: D9; entryPx9: D9 | null; benchEntryPx9: D9 | null; clientOrderId?: string;
}): void {
  db.prepare(
    `UPDATE ins_signals SET funded=1, skip_reason=NULL, entry_date=?, slot_notional9=?,
       entry_px9=?, bench_entry_px9=?, client_order_id=? WHERE cluster_id=?`,
  ).run(opts.entryDate, d9str(opts.slotNotional9),
    opts.entryPx9 !== null ? d9str(opts.entryPx9) : null,
    opts.benchEntryPx9 !== null ? d9str(opts.benchEntryPx9) : null,
    opts.clientOrderId ?? null, clusterId);
}

/** Shadow-only signals still need entry reference prices for CAR math. */
export function markShadow(db: DatabaseSync, clusterId: string, opts: {
  reason: string; entryDate: string; entryPx9: D9 | null; benchEntryPx9: D9 | null;
}): void {
  db.prepare(
    `UPDATE ins_signals SET funded=0, skip_reason=?, entry_date=?, entry_px9=?, bench_entry_px9=?
     WHERE cluster_id=?`,
  ).run(opts.reason, opts.entryDate,
    opts.entryPx9 !== null ? d9str(opts.entryPx9) : null,
    opts.benchEntryPx9 !== null ? d9str(opts.benchEntryPx9) : null, clusterId);
}

/** CAR over `nTradingDays` from the entry session. `symCloses`/`benchCloses` are ascending daily
 *  closes; the entry session is the first date ≥ entryDate. null until enough sessions exist (a
 *  CAR is never computed early — partial horizons would bias the book optimistic in drawdowns). */
export function computeCar(
  symCloses: { date: string; close9: D9 }[],
  benchCloses: { date: string; close9: D9 }[],
  entryDate: string,
  entryPx9: D9,
  benchEntryPx9: D9,
  nTradingDays: number,
): number | null {
  const symIdx = symCloses.findIndex((c) => c.date >= entryDate);
  const benchIdx = benchCloses.findIndex((c) => c.date >= entryDate);
  if (symIdx < 0 || benchIdx < 0) return null;
  const symTarget = symCloses[symIdx + nTradingDays];
  const benchTarget = benchCloses[benchIdx + nTradingDays];
  if (!symTarget || !benchTarget) return null;
  if (entryPx9 <= 0n || benchEntryPx9 <= 0n) return null;
  const symRet = d9num(symTarget.close9) / d9num(entryPx9) - 1;
  const benchRet = d9num(benchTarget.close9) / d9num(benchEntryPx9) - 1;
  return symRet - benchRet;
}

interface SignalRow {
  signal_id: number; cluster_id: string; symbol: string; entry_date: string | null;
  entry_px9: string | null; bench_entry_px9: string | null;
  car21: number | null; car63: number | null; car126: number | null;
}

/** Fill in any now-computable CARs across the whole book (funded AND shadow — same math, same
 *  benchmark, that's the point). Idempotent; safe to run nightly. Returns rows touched. */
export async function updateShadowCars(db: DatabaseSync, prices: PricePort, benchSymbol: string, asOfDate: string): Promise<number> {
  const rows = db.prepare(
    `SELECT signal_id, cluster_id, symbol, entry_date, entry_px9, bench_entry_px9, car21, car63, car126
     FROM ins_signals
     WHERE entry_date IS NOT NULL AND entry_px9 IS NOT NULL AND bench_entry_px9 IS NOT NULL
       AND (car21 IS NULL OR car63 IS NULL OR car126 IS NULL)`,
  ).all() as unknown as SignalRow[];
  if (!rows.length) return 0;

  // One benchmark series serves every row (start early enough for the oldest entry).
  const earliest = rows.reduce((a, r) => (r.entry_date! < a ? r.entry_date! : a), asOfDate);
  const bench = await prices.getCloses(benchSymbol, earliest, asOfDate);

  let touched = 0;
  const upd = db.prepare("UPDATE ins_signals SET car21=COALESCE(?,car21), car63=COALESCE(?,car63), car126=COALESCE(?,car126) WHERE signal_id=?");
  for (const r of rows) {
    const sym = await prices.getCloses(r.symbol, r.entry_date!, asOfDate);
    const need = (have: number | null, n: number): number | null =>
      have !== null ? null : computeCar(sym, bench, r.entry_date!, d9(r.entry_px9!), d9(r.bench_entry_px9!), n);
    const c21 = need(r.car21, 21);
    const c63 = need(r.car63, 63);
    const c126 = need(r.car126, 126);
    if (c21 !== null || c63 !== null || c126 !== null) {
      upd.run(c21, c63, c126, r.signal_id);
      touched++;
    }
  }
  return touched;
}
