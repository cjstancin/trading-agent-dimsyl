// Bull v2 — momentum sleeve PRIVATE tables (design §2). Sleeve-owned schema lives here, never in
// v2/db.ts: the shared migration chain stays sleeve-agnostic and three sleeves can ship in parallel
// without racing one migrations array. Everything is CREATE TABLE IF NOT EXISTS + idempotent
// REPLACE writes, so calling ensureMomTables at every entry point is free and re-runs are safe.
//
// Tables:
//   mom_universe    — monthly constituent snapshots (our OWN survivorship-free archive: Wikipedia's
//                     list pages only show the CURRENT index, so we must persist history ourselves)
//   mom_ranks       — monthly signal output: momentum top-50 with veto reasons + FIP final ranks
//                     (the audit trail: any month's book can be re-derived from its rank rows)
//   mom_shadow      — shadow books ("shadow50" = same recipe at N=50, "mirror" = live-N cost-free),
//                     paper-math NAV series — the sleeve's real evaluator vs QMOM
//   mom_honesty     — synthetic 5 bps/side slippage + $0.01/sell fee per REAL order intent.
//                     ANALYTICS ONLY: never touches fills/lots/cash_events (the tax ledger records
//                     actual paper fills only — lots.ts header rule)
//   mom_facts_cache — EDGAR companyfacts JSON per CIK, quarterly cadence (fundamentals move on
//                     10-Q/10-K filings; re-fetching 900 CIKs monthly would hammer SEC for nothing)
import type { DatabaseSync } from "node:sqlite";

export function ensureMomTables(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS mom_universe (
    month  TEXT NOT NULL,            -- YYYY-MM snapshot key (signal month-end)
    symbol TEXT NOT NULL,
    sector TEXT NOT NULL DEFAULT '', -- GICS sector from the Wikipedia table (debt-veto skip needs it)
    cik    TEXT,                     -- 10-digit zero-padded; NULL until resolved (SEC ticker map)
    list   TEXT NOT NULL DEFAULT '', -- 'sp500' | 'sp400'
    PRIMARY KEY (month, symbol)
  );

  CREATE TABLE IF NOT EXISTS mom_ranks (
    month         TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    score         REAL NOT NULL,     -- 12-1 total return (analytics — floats are fine off the money rail)
    dollar_volume REAL NOT NULL,
    fip           REAL,              -- sign(score) × (%neg − %pos); NULL for vetoed names
    mom_rank      INTEGER NOT NULL,  -- rank by raw momentum inside the top-50 (pre-veto)
    final_rank    INTEGER,           -- FIP-smoothness rank among veto survivors; NULL = vetoed
    veto          TEXT,              -- veto reason ('missing-fundamentals' | 'unprofitable' | 'accruals' | 'leverage')
    PRIMARY KEY (month, symbol)
  );

  CREATE TABLE IF NOT EXISTS mom_shadow (
    book     TEXT NOT NULL,          -- 'shadow50' | 'mirror'
    month    TEXT NOT NULL,
    holdings TEXT NOT NULL,          -- JSON [{symbol, weight}] — the book AFTER this month's re-rank
    nav9     TEXT NOT NULL,          -- d9 string, starts at 1; × (1 + month return) each month
    ret_pct  REAL,                   -- this month's paper-math return in %, NULL on inception month
    PRIMARY KEY (book, month)
  );

  CREATE TABLE IF NOT EXISTS mom_honesty (
    client_order_id TEXT PRIMARY KEY,  -- keyed to the REAL order intent (order_intents row)
    ts        TEXT NOT NULL,
    symbol    TEXT NOT NULL,
    side      TEXT NOT NULL CHECK (side IN ('buy','sell')),
    notional9 TEXT NOT NULL,           -- estimated notional the costs were computed from
    slippage9 TEXT NOT NULL,           -- notional × (slippageBpsPerSide / 10000)
    fee9      TEXT NOT NULL            -- $0.01 on sells, 0 on buys
  );

  CREATE TABLE IF NOT EXISTS mom_facts_cache (
    cik        TEXT PRIMARY KEY,
    fetched_ts TEXT NOT NULL,
    json       TEXT NOT NULL
  );
  `);
}
