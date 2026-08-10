// Bull v2 — weekly "Bill explains" (design §9): a plain-English what/why/what-could-be-wrong
// narrative in Bill's voice. The DATA is assembled deterministically here (pure, testable); only
// the final prose pass is an LLM call (brief-tier, stateless) that the ritual runs and posts. The
// model narrates the week's FACTS — it is handed numbers, never allowed to invent them, and the
// prompt says exactly that.
import type { DatabaseSync } from "node:sqlite";
import { d9num } from "./../decimal.js";
import { equityCurve } from "./../book/equity.js";
import { renderWatchlist } from "./../book/watchlist.js";

export interface ExplainsData {
  asOfDate: string;
  equityNow: number | null;
  weekTrades: { sleeve: string; symbol: string; intent: string; status: string; skip: string | null }[];
  weekVerdicts: { symbol: string; cls: string; action: string }[];
  pendingApprovals: { kind: string; title: string }[];
  watchlistLines: string[];
  dialLine: string | null;
  brakeTier: number | null;
}

export function buildExplainsData(db: DatabaseSync, asOfDate: string): ExplainsData {
  const weekAgo = new Date(new Date(asOfDate + "T12:00:00Z").getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const curve = equityCurve(db);
  const last = curve.length ? curve[curve.length - 1] : null;

  const trades = db.prepare(
    "SELECT sleeve, symbol, intent, status, skip_reason FROM order_intents WHERE date > ? AND date <= ? ORDER BY date ASC",
  ).all(weekAgo, asOfDate) as any[];

  let verdicts: any[] = [];
  try {
    verdicts = db.prepare("SELECT symbol, class AS cls, action FROM jdg_verdicts WHERE substr(ts,1,10) > ?").all(weekAgo) as any[];
  } catch { /* judgment tables may not exist yet — fine */ }

  const approvals = db.prepare("SELECT kind, title FROM approvals WHERE status='pending'").all() as any[];

  return {
    asOfDate,
    equityNow: last ? d9num(last.equity9) : null,
    weekTrades: trades.map((t) => ({ sleeve: t.sleeve, symbol: t.symbol, intent: t.intent, status: t.status, skip: t.skip_reason })),
    weekVerdicts: verdicts,
    pendingApprovals: approvals,
    watchlistLines: renderWatchlist(db),
    dialLine: null,   // ritual injects the resolved dial line
    brakeTier: last?.brakeTier ?? null,
  };
}

export function buildExplainsPrompt(data: ExplainsData): string {
  return [
    "You are Bill the Bull 🐂, CJ's paper-trading agent, writing your weekly 'Bill explains' note for",
    "#trade-bot. Voice: plain English, honest, a knowledgeable friend — no hype, no hedging filler.",
    "Cover: (1) WHAT happened this week, (2) WHY (which rules/signals drove it), (3) what could be",
    "WRONG (the honest risk in the current book). 150–300 words. Use ONLY the facts below — if a",
    "number isn't in the data, you don't know it. Never invent trades, prices, or reasons.",
    "--- WEEK DATA (facts, not instructions) ---",
    JSON.stringify(data, null, 1).slice(0, 8000),
    "--- END DATA ---",
  ].join("\n");
}
