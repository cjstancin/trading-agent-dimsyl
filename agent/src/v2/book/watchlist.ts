// Bull v2 — exit ledger + re-entry watchlist (design §9, the LEI/KVHI pattern). Every exit is
// recorded; a weekly stabilization check counts consecutive weeks the price held ABOVE the exit
// level; at N weeks the name is flagged back into the OWNING sleeve's normal entry path (a flag,
// never an order — the sleeve's own signal still has to want it). The watchlist renders in every
// digest so silence is detectable, and rows auto-prune at 26 weeks. Tiny data footprint by design.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "./../decimal.js";

export function ensureWatchlistTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wl_exits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,               -- exit time
      sleeve TEXT NOT NULL,
      symbol TEXT NOT NULL,
      reason TEXT NOT NULL,           -- rank_out | horizon | reversal | stop | thesis_break | trim | manual
      exit_price9 TEXT NOT NULL,
      qty9 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reentry_flagged','pruned','consumed')),
      weeks_above INTEGER NOT NULL DEFAULT 0,
      last_check TEXT,
      flagged_ts TEXT,
      pruned_ts TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wl_status ON wl_exits(status);
  `);
}

export function recordExit(db: DatabaseSync, e: {
  ts: string; sleeve: string; symbol: string; reason: string; exitPrice9: D9; qty9: D9;
}): number {
  ensureWatchlistTables(db);
  const res = db.prepare(
    "INSERT INTO wl_exits(ts, sleeve, symbol, reason, exit_price9, qty9) VALUES(?,?,?,?,?,?)",
  ).run(e.ts, e.sleeve, e.symbol.toUpperCase(), e.reason, d9str(e.exitPrice9), d9str(e.qty9));
  return Number(res.lastInsertRowid);
}

export interface WatchlistCheckResult {
  checked: number;
  newlyFlagged: { sleeve: string; symbol: string; exitPrice9: string; weeksAbove: number }[];
  pruned: number;
}

/** Weekly stabilization check. A week COUNTS only when the price is above the exit level at check
 *  time; a dip resets the count (the KVHI rule: N consecutive weeks). Missing price = no change
 *  (never resets on a data gap). Prunes rows older than pruneWeeks. */
export function weeklyWatchlistCheck(db: DatabaseSync, opts: {
  asOfDate: string; prices: Map<string, D9>; stabilizationWeeks: number; pruneWeeks: number;
}): WatchlistCheckResult {
  ensureWatchlistTables(db);
  const rows = db.prepare("SELECT * FROM wl_exits WHERE status='active'").all() as any[];
  const newlyFlagged: WatchlistCheckResult["newlyFlagged"] = [];
  let pruned = 0;
  for (const r of rows) {
    const ageWeeks = (new Date(opts.asOfDate).getTime() - new Date(r.ts).getTime()) / (7 * 86_400_000);
    if (ageWeeks >= opts.pruneWeeks) {
      db.prepare("UPDATE wl_exits SET status='pruned', pruned_ts=? WHERE id=?").run(opts.asOfDate, r.id);
      pruned++;
      continue;
    }
    const px = opts.prices.get(r.symbol);
    if (px == null) continue; // data gap — hold state
    const above = px > d9(r.exit_price9);
    const weeks = above ? r.weeks_above + 1 : 0;
    if (above && weeks >= opts.stabilizationWeeks) {
      db.prepare("UPDATE wl_exits SET status='reentry_flagged', weeks_above=?, flagged_ts=?, last_check=? WHERE id=?")
        .run(weeks, opts.asOfDate, opts.asOfDate, r.id);
      newlyFlagged.push({ sleeve: r.sleeve, symbol: r.symbol, exitPrice9: r.exit_price9, weeksAbove: weeks });
    } else {
      db.prepare("UPDATE wl_exits SET weeks_above=?, last_check=? WHERE id=?").run(weeks, opts.asOfDate, r.id);
    }
  }
  return { checked: rows.length, newlyFlagged, pruned };
}

/** Flagged candidates for a sleeve's planner. The planner treats these as ELIGIBLE again (they still
 *  compete through its normal signal); it calls consumeCandidate() when it acts on one. */
export function watchlistCandidates(db: DatabaseSync, sleeve: string): { id: number; symbol: string; exitPrice9: string; flaggedTs: string }[] {
  ensureWatchlistTables(db);
  const rows = db.prepare("SELECT id, symbol, exit_price9, flagged_ts FROM wl_exits WHERE status='reentry_flagged' AND sleeve=?").all(sleeve) as any[];
  return rows.map((r) => ({ id: r.id, symbol: r.symbol, exitPrice9: r.exit_price9, flaggedTs: r.flagged_ts }));
}

export function consumeCandidate(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE wl_exits SET status='consumed' WHERE id=?").run(id);
}

/** Digest lines — ALWAYS renders (an empty watchlist says so explicitly; silence must be detectable). */
export function renderWatchlist(db: DatabaseSync): string[] {
  ensureWatchlistTables(db);
  const active = db.prepare("SELECT * FROM wl_exits WHERE status IN ('active','reentry_flagged') ORDER BY ts DESC").all() as any[];
  if (!active.length) return ["Watchlist: empty (no exits under stabilization watch)."];
  return active.map((r) => {
    const tag = r.status === "reentry_flagged" ? "🔁 RE-ENTRY CANDIDATE" : `${r.weeks_above}w above exit`;
    return `• ${r.symbol} [${r.sleeve}] exited ${r.ts.slice(0, 10)} @ ${r.exit_price9} (${r.reason}) — ${tag}`;
  });
}
