// Bull v2 — Sunday-evening digest (design §9): per-sleeve week vs rivals, watchlist, LEI dial
// state, pending approvals, Monday's queued actions, gate progress. Pure composition over the DB —
// the ritual posts the returned string via postBill. Degrades HONESTLY: a missing series says so
// ("no marks yet"), it never renders a fabricated number.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9num, type D9 } from "./../decimal.js";
import { SLEEVES, SLEEVE_NAMES, type Sleeve } from "./../types.js";
import { equityCurve } from "./../book/equity.js";
import { benchSeries, gateProgress } from "./../book/benchmarks.js";
import { renderWatchlist } from "./../book/watchlist.js";

function pct(n: number | null): string {
  return n == null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

/** Week-over-week return of a value series ending at asOfDate (last vs ~7 days earlier). */
function weekChange(series: { date: string; value9: D9 }[], asOfDate: string): number | null {
  const upto = series.filter((r) => r.date <= asOfDate);
  if (upto.length < 2) return null;
  const last = upto[upto.length - 1];
  const weekAgoKey = new Date(new Date(asOfDate + "T12:00:00Z").getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  let base = upto[0];
  for (const r of upto) if (r.date <= weekAgoKey) base = r;
  if (base.date === last.date) return null;
  const a = Number(base.value9);
  const b = Number(last.value9);
  return a > 0 ? b / a - 1 : null;
}

export interface DigestExtras {
  dialLine?: string;            // resolved dial + flags (ritual passes resolveDial output)
  brakeLine?: string;           // brake tier + dd
  mondayQueue?: string[];       // planned Monday actions, pre-rendered lines
}

const RIVAL: Record<Sleeve, string> = { mom: "QMOM", ins: "IWM", anc: "NANC", wld: "SPY" };

export function sundayDigest(db: DatabaseSync, opts: { asOfDate: string; extras?: DigestExtras }): string {
  const { asOfDate, extras = {} } = opts;
  const lines: string[] = [];
  const curve = equityCurve(db).map((m) => ({ date: m.date, value9: m.equity9 }));
  const spy = benchSeries(db, "SPY");

  lines.push(`🐂 **Sunday digest — week ending ${asOfDate}**`);
  if (curve.length) {
    const eq = d9num(curve[curve.length - 1].value9);
    lines.push(`Book: $${eq.toFixed(2)} · week ${pct(weekChange(curve, asOfDate))} · SPY week ${pct(weekChange(spy, asOfDate))}`);
  } else {
    lines.push("Book: no equity marks yet.");
  }

  lines.push("", "**Sleeves**");
  for (const s of SLEEVES) {
    const series = benchSeries(db, `sleeve:${s}`);
    const rival = benchSeries(db, RIVAL[s]);
    const w = weekChange(series, asOfDate);
    const rw = weekChange(rival, asOfDate);
    lines.push(`• ${SLEEVE_NAMES[s]}: ${series.length ? `week ${pct(w)} (rival ${RIVAL[s]} ${pct(rw)})` : "no marks yet"}`);
  }

  if (extras.dialLine) lines.push("", `**LEI dial**: ${extras.dialLine}`);
  if (extras.brakeLine) lines.push(`**Brake**: ${extras.brakeLine}`);

  lines.push("", "**Watchlist**", ...renderWatchlist(db));

  const pending = db.prepare("SELECT kind, title FROM approvals WHERE status='pending' ORDER BY ts ASC").all() as { kind: string; title: string }[];
  lines.push("", "**Needs your call**");
  lines.push(...(pending.length ? pending.map((p) => `• [${p.kind}] ${p.title}`) : ["• queue empty"]));

  lines.push("", "**Monday queue**");
  lines.push(...(extras.mondayQueue?.length ? extras.mondayQueue.map((q) => `• ${q}`) : ["• nothing scheduled beyond standing cadences"]));

  const gp = gateProgress(db, { asOfDate, ddCeilingPct: 15 });
  lines.push("", `**Live gate**: ${gp.monthsCovered}/12 mo · book ${pct(gp.bookTR)} vs SPY ${pct(gp.spyTR)} · max DD ${gp.realizedMaxDDPct.toFixed(1)}% (ceiling 15%) · ${gp.green ? "🟢 GREEN" : "not yet green"}`);
  return lines.join("\n");
}
