// Per-SYMBOL trade memory (Bull learning loop, part 2) — PURE render of Bill's OWN closed-trade history
// per ticker into compact prompt blocks. The setup-level loop (track-record.ts) tells Bill which KINDS of
// trades worked, but nothing told him "you personally lost on MU before" when MU resurfaced — the ledger
// held the record and no prompt ever read it back. This closes that gap: wherever Bill weighs a symbol he
// has prior closed trades on (scan watchlist-building, execute order-proposing, reallocation re-scoring),
// that record is rendered into the prompt.
//
// FRAMING (essential — deliberately different from track-record.ts): a per-symbol record is HISTORY, not a
// statistical edge. A single prior loss on a name is worth SHOWING even at n=1, so there is NO min-N gate
// here; instead every block carries an explicit small-sample disclaimer and a prior loss NEVER hard-blocks
// a re-buy (a name can be a great trade later). ADVISORY ONLY: prompt text for the model; deterministic
// sizing (risk-engine.ts) is untouched. Pure, no network, fail-open (no history → "" → nothing added).

/** Minimal closed-trade shape this module needs — a structural subset of ledger ProposalRecord. */
export interface SymbolTrade {
  ts: string;                       // ISO timestamp of the proposal/entry
  symbol: string;
  setup?: string | null;            // setup/strategy tag (Bull v2 #5)
  outcome?: string | null;          // "win" | "loss" | … (only win/loss count as closed)
  realizedPnlUsd?: number | null;   // back-filled by reconcile()
  rMultiple?: number | null;        // back-filled by reconcile()
}

/** Compact per-symbol record over Bill's CLOSED trades on that name. */
export interface SymbolRecord {
  symbol: string;
  count: number;                    // closed trades on this name
  wins: number;
  losses: number;
  avgR: number | null;              // mean R-multiple over trades that carry one; null if none do
  totalPnl: number;                 // sum realized $ on this name
  setups: string[];                 // distinct setup tags seen on this name (entry order)
  lastDate: string;                 // YYYY-MM-DD of the most recent closed trade's entry
  lastSetup: string | null;
  lastOutcome: "win" | "loss";
  lastR: number | null;
}

/** Scan-block cap: only the N most recently traded symbols are listed, so the block stays bounded as the
 *  ledger grows (older names age out; execute still surfaces ANY proposed name's record on demand). */
export const DEFAULT_SYMBOL_HISTORY_CAP = 20;

const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => (n < 0 ? "−$" + Math.abs(n).toFixed(0) : "+$" + n.toFixed(0));
const rfmt = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "R";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Group the ledger's CLOSED trades (outcome win/loss only — open/expired/unknown never count) by symbol
 * and summarize each into a SymbolRecord. Symbols are normalized to upper-case. Pure; empty in → empty out.
 */
export function symbolRecords(trades: SymbolTrade[]): Record<string, SymbolRecord> {
  const closed = (trades ?? []).filter((t) => t && t.symbol && (t.outcome === "win" || t.outcome === "loss"));
  const bySym: Record<string, SymbolTrade[]> = {};
  for (const t of closed) (bySym[String(t.symbol).trim().toUpperCase()] ||= []).push(t);
  const out: Record<string, SymbolRecord> = {};
  for (const sym in bySym) {
    const rows = bySym[sym].slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const wins = rows.filter((t) => t.outcome === "win").length;
    const rs = rows.map((t) => t.rMultiple).filter((r): r is number => typeof r === "number" && Number.isFinite(r));
    const setups: string[] = [];
    for (const t of rows) { const s = (t.setup && String(t.setup).trim()) || "untagged"; if (!setups.includes(s)) setups.push(s); }
    const last = rows[rows.length - 1];
    out[sym] = {
      symbol: sym,
      count: rows.length,
      wins,
      losses: rows.length - wins,
      avgR: rs.length ? r2(rs.reduce((s, x) => s + x, 0) / rs.length) : null,
      totalPnl: r2(rows.reduce((s, t) => s + num(t.realizedPnlUsd), 0)),
      setups,
      lastDate: String(last.ts).slice(0, 10),
      lastSetup: (last.setup && String(last.setup).trim()) || null,
      lastOutcome: last.outcome === "win" ? "win" : "loss",
      lastR: typeof last.rMultiple === "number" && Number.isFinite(last.rMultiple) ? r2(last.rMultiple) : null,
    };
  }
  return out;
}

/** The record for ONE symbol (case-insensitive), or null when Bill has no closed history on it. */
export function symbolRecord(trades: SymbolTrade[], symbol: string): SymbolRecord | null {
  if (!symbol || !String(symbol).trim()) return null;
  return symbolRecords(trades)[String(symbol).trim().toUpperCase()] ?? null;
}

/** One compact line for a symbol's record, e.g.
 *  "MU: 3 trades · 1W/2L · avg −0.9R · total −$142 · last: 2026-06-20 failed-breakout loss −1.2R · setups: …" */
export function renderSymbolRecordLine(rec: SymbolRecord): string {
  const avg = rec.avgR != null ? `avg ${rfmt(rec.avgR)}` : `avg ${usd(rec.count ? r2(rec.totalPnl / rec.count) : 0)}/trade`;
  const last = `last: ${rec.lastDate} ${rec.lastSetup ?? "untagged"} ${rec.lastOutcome}${rec.lastR != null ? ` ${rfmt(rec.lastR)}` : ""}`;
  const setups = rec.setups.length ? ` · setups: ${rec.setups.join(", ")}` : "";
  return `${rec.symbol}: ${rec.count} trade${rec.count === 1 ? "" : "s"} · ${rec.wins}W/${rec.losses}L · ${avg} · total ${usd(rec.totalPnl)} · ${last}${setups}`;
}

// The small-sample framing every per-symbol block leads with — history to WEIGH, never a rule.
const FRAMING =
  "your OWN closed-trade record on each. This is HISTORY, not a statistical edge — samples are small, " +
  "so judge each fresh thesis on its own merits. A past loss never forbids a re-buy and a past win " +
  "guarantees nothing; just weigh it";

/**
 * Render the scan-ritual "SYMBOLS YOU'VE TRADED BEFORE" prompt block: every previously traded symbol with
 * its per-symbol record, most recently traded first, CAPPED at `cap` names (the long tail is disclosed as
 * "+N more", never silently dropped) so the block stays bounded as the ledger grows. Returns "" when there
 * is no closed trade yet, so a fresh account adds nothing to the prompt.
 */
export function renderSymbolHistoryBlock(trades: SymbolTrade[], cap: number = DEFAULT_SYMBOL_HISTORY_CAP): string {
  const recs = Object.values(symbolRecords(trades))
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.symbol.localeCompare(b.symbol));
  if (!recs.length) return "";
  const shown = recs.slice(0, Math.max(1, Math.floor(cap) || 1));
  const more = recs.length - shown.length;
  return (
    `SYMBOLS YOU'VE TRADED BEFORE — ${FRAMING}:\n` +
    shown.map((r) => `• ${renderSymbolRecordLine(r)}`).join("\n") +
    (more > 0 ? `\n(+${more} more previously traded name${more === 1 ? "" : "s"} not shown — ${shown.length} most recently traded kept)` : "")
  );
}

/**
 * Render the execute-ritual annotation: the per-symbol record for each of the given (proposed / candidate)
 * symbols that has prior closed history. Symbols with no history contribute nothing; no hits → "" (fail
 * open). Advisory only — never a hard block on a re-buy.
 */
export function renderProposedSymbolHistory(trades: SymbolTrade[], symbols: string[]): string {
  const recs = symbolRecords(trades);
  const seen = new Set<string>();
  const hits: SymbolRecord[] = [];
  for (const s of symbols ?? []) {
    const sym = String(s ?? "").trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    if (recs[sym]) hits.push(recs[sym]);
  }
  if (!hits.length) return "";
  return `YOUR HISTORY ON THESE NAMES — ${FRAMING}:\n` + hits.map((r) => `• ${renderSymbolRecordLine(r)}`).join("\n");
}

/**
 * Which previously traded symbols appear (word-bounded) in a free-text block (e.g. the approved cycle)?
 * Matches against the ledger's own traded-symbol set — never guesses tickers out of prose — so "MU" inside
 * "MUSK" doesn't hit. Sorted for determinism. Pure.
 */
export function tradedSymbolsIn(trades: SymbolTrade[], text: string): string[] {
  if (!text) return [];
  return Object.keys(symbolRecords(trades))
    .filter((sym) => new RegExp(`\\b${escapeRe(sym)}\\b`).test(text))
    .sort();
}
