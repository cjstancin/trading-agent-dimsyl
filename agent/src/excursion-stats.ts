// Excursion (MAE/MFE) reporting analytics — PURE, no network, read-only over the journal's closed trades.
// The per-trade MAE/MFE numbers themselves are computed at journal time (mae-mfe.ts, attached to each
// memory/journal.jsonl entry as maePct/maeUsd/mfePct/mfeUsd). This module only AGGREGATES those already-
// recorded fields into a portfolio-level summary (avg MAE/MFE, capture ratio) and renders Discord-friendly
// lines for Bill's EOD report. It slices the same journal records the dashboard already reads, so it is
// trivially unit-testable and cannot touch any live/paper trading path.
//
// Capture ratio = how much of the available favorable move was realized at exit: sum(pnlPct)/sum(mfePct)
// over trades that had a favorable excursion (mfePct > 0), expressed as an integer percent. 100% means
// trades on average exited at their high-water mark; a low/negative ratio means favorable moves were given
// back before exit. Aggregated in % space so it is independent of per-trade share count.
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const defined = (v: unknown): boolean => v != null && Number.isFinite(typeof v === "string" ? parseFloat(v) : (v as number));

/** Minimal closed-trade shape excursion stats need — a structural subset of a journal entry. */
export interface ExcursionTrade {
  symbol?: string;
  closedAt?: string;
  pnlPct?: number | null;            // realized return at exit (% of entry)
  maePct?: number | null;            // max adverse excursion (% of entry, usually <= 0)
  maeUsd?: number | null;            // max adverse excursion (per-share $)
  mfePct?: number | null;            // max favorable excursion (% of entry, usually >= 0)
  mfeUsd?: number | null;            // max favorable excursion (per-share $)
}

export interface ExcursionSummary {
  trades: number;        // closed trades that HAVE excursion data (bars were available at journal time)
  avgMaePct: number;     // mean MAE % over those trades
  avgMaeUsd: number;     // mean MAE per-share $ over those trades
  avgMfePct: number;     // mean MFE % over those trades
  avgMfeUsd: number;     // mean MFE per-share $ over those trades
  captureRatio: number;  // integer %; sum(pnlPct)/sum(mfePct) over trades with mfePct > 0 (see header)
}

/** A trade carries excursion data iff at least one of its four MAE/MFE fields is a finite number. */
export function hasExcursion(t: ExcursionTrade | null | undefined): boolean {
  return !!t && (defined(t.maePct) || defined(t.maeUsd) || defined(t.mfePct) || defined(t.mfeUsd));
}

/**
 * Portfolio-level excursion summary over the given closed trades. Pure; the caller passes journal entries
 * (with or without excursion fields — entries lacking them are filtered out here). Returns a fully-zeroed
 * summary when no trade carries excursion data, so a fresh account reports nothing rather than crashing.
 */
export function excursionSummary(trades: ExcursionTrade[]): ExcursionSummary {
  const withData = (trades ?? []).filter(hasExcursion);
  const n = withData.length;
  if (!n) return { trades: 0, avgMaePct: 0, avgMaeUsd: 0, avgMfePct: 0, avgMfeUsd: 0, captureRatio: 0 };
  const avgMaePct = r2(mean(withData.map((t) => num(t.maePct))));
  const avgMaeUsd = r2(mean(withData.map((t) => num(t.maeUsd))));
  const avgMfePct = r2(mean(withData.map((t) => num(t.mfePct))));
  const avgMfeUsd = r2(mean(withData.map((t) => num(t.mfeUsd))));
  // Capture ratio: realized vs available favorable move, aggregated in % space over trades that actually
  // had a favorable excursion. A non-positive total MFE (no favorable room) → 0 rather than a divide blow-up.
  const favorable = withData.filter((t) => num(t.mfePct) > 0);
  const totMfe = favorable.reduce((s, t) => s + num(t.mfePct), 0);
  const totPnl = favorable.reduce((s, t) => s + num(t.pnlPct), 0);
  const captureRatio = totMfe > 0 ? Math.round((totPnl / totMfe) * 100) : 0;
  return { trades: n, avgMaePct, avgMaeUsd, avgMfePct, avgMfeUsd, captureRatio };
}

const sPct = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "%";
const sUsd = (n: number) => (n < 0 ? "−$" : "+$") + Math.abs(n).toFixed(2);

/**
 * One-line Discord-friendly portfolio excursion footer, or "" when no trade carries excursion data.
 * e.g. "🎯 Excursion (MAE/MFE): avg MAE −1.2% / MFE +2.4% · capture 58% (7 trades)"
 */
export function renderExcursionFooter(summary: ExcursionSummary): string {
  if (!summary || summary.trades <= 0) return "";
  return `🎯 Excursion (MAE/MFE): avg MAE ${sPct(summary.avgMaePct)} / MFE ${sPct(summary.avgMfePct)} · capture ${summary.captureRatio}% (${summary.trades} trades)`;
}

/**
 * Per-trade excursion lines for the given closed trades (only those carrying excursion data), e.g.
 *   "   • TSLA: MAE −1.5% (−$0.45) / MFE +3.2% (+$0.96)"
 * Returns [] when none carry data. `limit` caps the list (default 10) to keep the EOD wrap within budget.
 */
export function renderExcursionLines(trades: ExcursionTrade[], limit = 10): string[] {
  return (trades ?? [])
    .filter(hasExcursion)
    .slice(0, Math.max(0, limit))
    .map((t) => `   • ${t.symbol ?? "?"}: MAE ${sPct(num(t.maePct))} (${sUsd(num(t.maeUsd))}) / MFE ${sPct(num(t.mfePct))} (${sUsd(num(t.mfeUsd))})`);
}
