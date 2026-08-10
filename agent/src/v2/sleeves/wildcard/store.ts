// Bull v2 — Wildcard sleeve private storage. Sleeve-private tables are created HERE with
// CREATE TABLE IF NOT EXISTS (db.ts migration v2 comment: sleeve tables never edit db.ts), all
// prefixed wld_. Two tables:
//   wld_picks     — one row per weekly run: pool snapshot, cards, RAW model response, validation
//                   outcome, the applied plan, config version. This is the audit trail that lets a
//                   Sunday digest (or a post-mortem) replay exactly what the model saw and said.
//                   It is NEVER fed back into a prompt — fresh context every call (design §6).
//   wld_book_log  — enter/exit events per symbol. The EXIT rows are the re-entry cooldown clock
//                   (4 weeks, config) — kept sleeve-side rather than derived from disposals because
//                   the cooldown starts at the DECISION, not the fill, and applies regardless of
//                   whether the exit realized a loss (the gateway's 31-day wash blacklist is the
//                   separate, loss-only rail).
// Shared position_meta (sleeve='wld') carries per-position state: thesis, ORIGINAL invalidation
// level, entry/peak/atrStop for the ratchet. Helpers here own its JSON (de)serialization.
import type { DatabaseSync } from "node:sqlite";
import type { WldPosMeta } from "./types.js";

export const SLEEVE = "wld" as const;

export function ensureWildcardTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wld_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week TEXT NOT NULL,            -- ET date key of the weekly run
      ts TEXT NOT NULL,
      pool_json TEXT NOT NULL,       -- PoolEntry[] snapshot (already excludes held names)
      cards_json TEXT NOT NULL,      -- ContextCard[] exactly as sent to the model
      response_raw TEXT NOT NULL,    -- model output verbatim (stringified if it arrived parsed)
      valid INTEGER NOT NULL,        -- 1 = schema-valid, 0 = rejected (book kept)
      reject_reason TEXT,
      action_json TEXT NOT NULL,     -- {action, plan, orders} — what code actually did
      config_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wld_picks_week ON wld_picks(week);

    CREATE TABLE IF NOT EXISTS wld_book_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('enter','exit')),
      week TEXT NOT NULL,            -- ET date key of the decision
      reason TEXT,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wld_book_log_sym ON wld_book_log(symbol, week);
  `);
}

// ---------------------------------------------------------------------------
// position_meta (shared table, sleeve='wld') helpers
// ---------------------------------------------------------------------------

export interface HeldRow { symbol: string; meta: WldPosMeta }

export function saveMeta(db: DatabaseSync, symbol: string, meta: WldPosMeta): void {
  db.prepare(
    `INSERT INTO position_meta(sleeve, symbol, meta, updated_ts) VALUES(?,?,?,?)
     ON CONFLICT(sleeve, symbol) DO UPDATE SET meta=excluded.meta, updated_ts=excluded.updated_ts`,
  ).run(SLEEVE, symbol.toUpperCase(), JSON.stringify(meta), new Date().toISOString());
}

export function loadMeta(db: DatabaseSync, symbol: string): WldPosMeta | null {
  const row = db.prepare("SELECT meta FROM position_meta WHERE sleeve=? AND symbol=?")
    .get(SLEEVE, symbol.toUpperCase()) as { meta: string } | undefined;
  return row ? (JSON.parse(row.meta) as WldPosMeta) : null;
}

/** Every wld position_meta row, parsed. `activeOnly` filters out rows that are already on their way
 *  out (pendingExit) or frozen awaiting a thesis-check (stopFired) — churn and the stop engine both
 *  operate on ACTIVE rows only, while pool exclusion uses the full set (a name mid-exit is still
 *  held and must not be re-pitched to the model). */
export function heldPositions(db: DatabaseSync, activeOnly: boolean): HeldRow[] {
  const rows = db.prepare("SELECT symbol, meta FROM position_meta WHERE sleeve=? ORDER BY symbol")
    .all(SLEEVE) as { symbol: string; meta: string }[];
  const out: HeldRow[] = [];
  for (const r of rows) {
    const meta = JSON.parse(r.meta) as WldPosMeta;
    if (activeOnly && (meta.pendingExit || meta.stopFired)) continue;
    out.push({ symbol: r.symbol, meta });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Book log (enter/exit) — the churn engine's history feed
// ---------------------------------------------------------------------------

export function logBookEvent(db: DatabaseSync, symbol: string, event: "enter" | "exit", week: string, reason: string): void {
  db.prepare("INSERT INTO wld_book_log(symbol, event, week, reason, ts) VALUES(?,?,?,?,?)")
    .run(symbol.toUpperCase(), event, week, reason, new Date().toISOString());
}

/** Exits on/after `sinceWeek` (ET date key) — the re-entry cooldown window feed. */
export function recentExits(db: DatabaseSync, sinceWeek: string): { symbol: string; exitedOn: string }[] {
  const rows = db.prepare("SELECT symbol, week FROM wld_book_log WHERE event='exit' AND week >= ? ORDER BY week")
    .all(sinceWeek) as { symbol: string; week: string }[];
  return rows.map((r) => ({ symbol: r.symbol, exitedOn: r.week }));
}

// ---------------------------------------------------------------------------
// Weekly pick audit row
// ---------------------------------------------------------------------------

export interface PickRunRecord {
  week: string;
  poolJson: string;
  cardsJson: string;
  responseRaw: string;
  valid: boolean;
  rejectReason?: string;
  actionJson: string;
  configVersion: string;
}

export function recordPickRun(db: DatabaseSync, r: PickRunRecord): void {
  db.prepare(
    `INSERT INTO wld_picks(week, ts, pool_json, cards_json, response_raw, valid, reject_reason, action_json, config_version)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(r.week, new Date().toISOString(), r.poolJson, r.cardsJson, r.responseRaw,
    r.valid ? 1 : 0, r.rejectReason ?? null, r.actionJson, r.configVersion);
}
