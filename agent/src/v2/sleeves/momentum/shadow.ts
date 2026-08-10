// Bull v2 — momentum shadow books (design §2). Two paper-math books run beside the live sleeve:
//
//   "shadow50" — the SAME recipe at N=50, $0 cost. This is the sleeve's REAL evaluator: academic
//                momentum lives at breadth the live $2k sleeve can't afford, so if shadow50 beats
//                the live book persistently, the live book's N (or costs) is the problem, not the
//                signal. Benchmark rival for the whole exercise: QMOM.
//   "mirror"   — the live recipe at the live N, also $0 cost. The honesty-ledger drag is exactly
//                (mirror − live), and (shadow50 − mirror) isolates the breadth penalty.
//
// Paper-math = pure arithmetic on month-end adjusted closes: hold last month's book, mark it with
// this month's closes, chain the NAV, re-form at this month's ranks. No orders, no cash, no d9
// ledger rows — it's ANALYTICS (floats fine), persisted in mom_shadow keyed (book, month) so
// re-runs REPLACE deterministically instead of double-counting.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9num, d9str } from "../../decimal.js";
import { ensureMomTables } from "./schema.js";
import { honestyTotals } from "./honesty.js";
import { shiftMonth } from "./ports.js";

export interface ShadowHolding { symbol: string; weight: number }

export interface ShadowRow {
  book: string;
  month: string;
  holdings: ShadowHolding[];
  nav9: string;
  retPct: number | null;
}

/** Advance one shadow book by one month. `closes` maps symbol → (month → adjusted close); it must
 *  cover last month's holdings at both month-ends to mark them (a symbol missing a close — halt,
 *  delisting, data gap — contributes 0% that month, the conservative neutral). `finalRanked` is
 *  this month's survivor list in final-rank order; the book re-forms as its top `n`, equal-weight. */
export function runShadowMonth(
  db: DatabaseSync,
  book: "shadow50" | "mirror",
  month: string,
  finalRanked: string[],
  n: number,
  closes: Map<string, Map<string, number>>,
): ShadowRow {
  ensureMomTables(db);
  const prevMonth = shiftMonth(month, -1);
  const prev = db
    .prepare("SELECT holdings, nav9 FROM mom_shadow WHERE book=? AND month=?")
    .get(book, prevMonth) as { holdings: string; nav9: string } | undefined;

  let retPct: number | null = null;
  let nav = 1;
  if (prev) {
    const prevHoldings = JSON.parse(prev.holdings) as ShadowHolding[];
    let ret = 0;
    for (const h of prevHoldings) {
      const c0 = closes.get(h.symbol)?.get(prevMonth);
      const c1 = closes.get(h.symbol)?.get(month);
      if (c0 != null && c1 != null && c0 > 0) ret += h.weight * (c1 / c0 - 1);
      // else: unmarkable → 0% contribution (never invent a return)
    }
    retPct = ret * 100;
    nav = d9num(d9(prev.nav9)) * (1 + ret);
  }

  const picks = finalRanked.slice(0, n);
  const holdings: ShadowHolding[] = picks.map((symbol) => ({ symbol, weight: picks.length ? 1 / picks.length : 0 }));
  const nav9 = d9str(d9(nav.toFixed(9)));

  db.prepare("INSERT OR REPLACE INTO mom_shadow(book, month, holdings, nav9, ret_pct) VALUES(?,?,?,?,?)")
    .run(book, month, JSON.stringify(holdings), nav9, retPct);
  return { book, month, holdings, nav9, retPct };
}

export function shadowRow(db: DatabaseSync, book: string, month: string): ShadowRow | null {
  const r = db.prepare("SELECT holdings, nav9, ret_pct FROM mom_shadow WHERE book=? AND month=?")
    .get(book, month) as { holdings: string; nav9: string; ret_pct: number | null } | undefined;
  if (!r) return null;
  return { book, month, holdings: JSON.parse(r.holdings) as ShadowHolding[], nav9: r.nav9, retPct: r.ret_pct };
}

export interface BookCompare {
  month: string;
  shadow50: ShadowRow | null;
  mirror: ShadowRow | null;
  honesty: { slippage9: string; fees9: string; orders: number };
}

/** One month, three lenses: shadow50 (breadth ceiling), mirror (cost-free live recipe), and the
 *  honesty drag that separates mirror from the live book. Raw evaluator data — judgment upstream. */
export function compareBooks(db: DatabaseSync, month: string): BookCompare {
  ensureMomTables(db);
  const h = honestyTotals(db, month);
  return {
    month,
    shadow50: shadowRow(db, "shadow50", month),
    mirror: shadowRow(db, "mirror", month),
    honesty: { slippage9: d9str(h.slippage9), fees9: d9str(h.fees9), orders: h.orders },
  };
}
