// Bull v2 — monthly statement (design §9): the dad-style rail, CJ-only. Plain-English monthly
// close: equity open/close, month TR vs SPY, realized P&L from the tax ledger (economic AND
// tax-adjusted views), fees, per-sleeve table, wash/blacklist notes, gate progress. Pure over the
// DB; the ritual posts it via postBill (or mails it later — the rail composes text, not transport).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9num, type D9 } from "./../decimal.js";
import { SLEEVES, SLEEVE_NAMES } from "./../types.js";
import { equityCurve } from "./../book/equity.js";
import { benchSeries, gateProgress } from "./../book/benchmarks.js";

function money(v: D9): string { return `$${d9num(v).toFixed(2)}`; }
function pct(n: number | null): string { return n == null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`; }

function monthReturn(series: { date: string; value9: D9 }[], month: string): { open: D9 | null; close: D9 | null; ret: number | null } {
  const inMonth = series.filter((r) => r.date.startsWith(month));
  const before = series.filter((r) => r.date < month + "-01");
  const open = before.length ? before[before.length - 1].value9 : inMonth.length ? inMonth[0].value9 : null;
  const close = inMonth.length ? inMonth[inMonth.length - 1].value9 : null;
  const ret = open != null && close != null && open > 0n ? Number(close) / Number(open) - 1 : null;
  return { open, close, ret };
}

/** Compose the statement for month "YYYY-MM". */
export function monthlyStatement(db: DatabaseSync, month: string): string {
  const lines: string[] = [];
  const curve = equityCurve(db).map((m) => ({ date: m.date, value9: m.equity9 }));
  const book = monthReturn(curve, month);
  const spy = monthReturn(benchSeries(db, "SPY"), month);

  lines.push(`🐂 **Bill the Bull — monthly statement · ${month}** (paper book)`);
  lines.push("");
  lines.push(`Equity: ${book.open != null ? money(book.open) : "—"} → ${book.close != null ? money(book.close) : "—"} (${pct(book.ret)}) · SPY ${pct(spy.ret)}`);

  // Realized P&L from disposals closed in the month — economic AND tax views, separately.
  const disp = db.prepare("SELECT realized9, wash_disallowed9, term, symbol, sleeve FROM disposals WHERE substr(close_ts,1,7)=?").all(month) as any[];
  const realized = disp.reduce((a, r) => a + d9(r.realized9), 0n);
  const disallowed = disp.reduce((a, r) => a + d9(r.wash_disallowed9), 0n);
  const shortTerm = disp.filter((r) => r.term === "short").reduce((a, r) => a + d9(r.realized9), 0n);
  lines.push(`Realized this month: ${money(realized)} economic across ${disp.length} closes (${money(shortTerm)} short-term)` +
    (disallowed > 0n ? ` · wash-disallowed ${money(disallowed)} deferred into replacement basis` : " · no wash-sale events"));

  lines.push("", "**Per sleeve (month)**");
  for (const s of SLEEVES) {
    const sr = monthReturn(benchSeries(db, `sleeve:${s}`), month);
    const closes = disp.filter((r) => r.sleeve === s);
    const sRealized = closes.reduce((a, r) => a + d9(r.realized9), 0n);
    lines.push(`• ${SLEEVE_NAMES[s]}: ${sr.ret != null ? pct(sr.ret) : "no marks"} · ${closes.length} closes (${money(sRealized)})`);
  }

  const skips = db.prepare("SELECT skip_reason, COUNT(*) AS n FROM order_intents WHERE substr(date,1,7)=? AND status='skipped' GROUP BY skip_reason").all(month) as any[];
  if (skips.length) {
    lines.push("", "**Gate refusals** (every refusal is recorded — nothing fails silently)");
    for (const s of skips) lines.push(`• ${s.skip_reason}: ${s.n}`);
  }

  const lastDay = curve.filter((r) => r.date.startsWith(month));
  const asOf = lastDay.length ? lastDay[lastDay.length - 1].date : `${month}-28`;
  const gp = gateProgress(db, { asOfDate: asOf, ddCeilingPct: 15 });
  lines.push("", `**Live gate**: ${gp.monthsCovered}/12 mo · rolling book ${pct(gp.bookTR)} vs SPY ${pct(gp.spyTR)} · max DD ${gp.realizedMaxDDPct.toFixed(1)}% · ${gp.green ? "🟢 GREEN" : "not yet green"}`);
  lines.push("", "_Paper only. The internal FIFO ledger is the performance truth; Alpaca is the position truth._");
  return lines.join("\n");
}
