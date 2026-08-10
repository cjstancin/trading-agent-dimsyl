// Bull v2 — SQLite store (node:sqlite, zero new deps; Node ≥22.5 ships DatabaseSync — the VPS's
// v22 prints an ExperimentalWarning, harmless). One DB file holds the tax ledger (fills/lots/
// disposals/wash_links), the settled-cash ledger, order intents, and small key-value state.
// All quantities/dollars are d9 bigint strings (see decimal.ts) — TEXT columns, never REAL.
// Migrations are forward-only and versioned in `meta`; opening an old DB upgrades it in place.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../runtime/v2/bull.db", import.meta.url));

const MIGRATIONS: string[] = [
  // v1 — Phase 1 foundation schema.
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Every FILL activity from Alpaca, idempotent by activity id. sleeve is resolved from the
  -- deterministic client_order_id prefix; NULL = untagged (manual/dashboard order — reconcile flags it).
  CREATE TABLE fills (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    client_order_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    qty9 TEXT NOT NULL,
    price9 TEXT NOT NULL,
    ts TEXT NOT NULL,
    sleeve TEXT,
    raw TEXT NOT NULL
  );
  CREATE INDEX idx_fills_symbol_ts ON fills(symbol, ts);

  -- FIFO tax lots. basis_total9 is the ORIGINAL cost; wash_adj_basis9 is the disallowed-loss
  -- adjustment kept SEPARATE (design §7). holding_period_start_ts differs from open_ts when
  -- wash-sale tacking applied. qty_remaining9 is consumed FIFO by disposals.
  CREATE TABLE lots (
    lot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    sleeve TEXT,
    open_fill_id TEXT NOT NULL REFERENCES fills(id),
    open_ts TEXT NOT NULL,
    holding_period_start_ts TEXT NOT NULL,
    qty_open9 TEXT NOT NULL,
    qty_remaining9 TEXT NOT NULL,
    basis_total9 TEXT NOT NULL,
    -- Operative remaining basis (original + wash adjustments not yet consumed by disposals).
    -- Consumption allocates from THIS so a fully-consumed lot's disposal bases sum EXACTLY.
    basis_remaining9 TEXT NOT NULL,
    wash_adj_basis9 TEXT NOT NULL DEFAULT '0',
    source TEXT NOT NULL DEFAULT 'bull-v2'
  );
  CREATE INDEX idx_lots_symbol ON lots(symbol);

  -- One row per (sell fill × consumed lot). basis9 includes any wash adjustment present on the lot
  -- at recompute time; realized9 = proceeds9 - basis9. wash_disallowed9 > 0 marks a wash-sale loss
  -- (disallowed portion), provisional until wash_provisional_until (re-scanned on every buy).
  CREATE TABLE disposals (
    disposal_id INTEGER PRIMARY KEY AUTOINCREMENT,
    sell_fill_id TEXT NOT NULL REFERENCES fills(id),
    lot_id INTEGER NOT NULL REFERENCES lots(lot_id),
    symbol TEXT NOT NULL,
    sleeve TEXT,
    qty9 TEXT NOT NULL,
    proceeds9 TEXT NOT NULL,
    basis9 TEXT NOT NULL,
    realized9 TEXT NOT NULL,
    open_ts TEXT NOT NULL,
    close_ts TEXT NOT NULL,
    holding_period_start_ts TEXT NOT NULL,
    term TEXT NOT NULL CHECK (term IN ('short','long')),
    wash_disallowed9 TEXT NOT NULL DEFAULT '0',
    wash_provisional_until TEXT
  );
  CREATE INDEX idx_disposals_symbol_close ON disposals(symbol, close_ts);

  -- Wash-sale matches: which replacement lot absorbed how much disallowed loss from which disposal.
  CREATE TABLE wash_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    disposal_id INTEGER NOT NULL REFERENCES disposals(disposal_id),
    replacement_lot_id INTEGER NOT NULL REFERENCES lots(lot_id),
    qty9 TEXT NOT NULL,
    disallowed9 TEXT NOT NULL,
    created_ts TEXT NOT NULL
  );

  -- Settled-cash ledger (design §1): the bot's OWN cash truth — sizing NEVER reads buying_power.
  -- amount9 is signed; settles_on is the ET trading date the cash becomes spendable (T+1 for sale
  -- proceeds, same-day for buys/seed). available = Σ amount9 where settles_on ≤ today.
  CREATE TABLE cash_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('seed','buy','sell','dividend','fee','sweep_buy','sweep_sell','adjust')),
    symbol TEXT,
    amount9 TEXT NOT NULL,
    settles_on TEXT NOT NULL,
    ref TEXT,
    note TEXT
  );
  CREATE INDEX idx_cash_settles ON cash_events(settles_on);
  -- Replay idempotency: a fill-driven cash event (buy/sell/dividend) carries ref = fill/activity id;
  -- re-running reconcile must not double-book it.
  CREATE UNIQUE INDEX idx_cash_kind_ref ON cash_events(kind, ref) WHERE ref IS NOT NULL;

  -- Order intents: audit + idempotency. client_order_id is deterministic
  -- ({sleeve}:{symbol}:{intent}:{yyyymmdd}:{seq}) so a replay after timeout can query the broker
  -- by id BEFORE any resubmit (design §7).
  CREATE TABLE order_intents (
    client_order_id TEXT PRIMARY KEY,
    sleeve TEXT NOT NULL,
    symbol TEXT NOT NULL,
    intent TEXT NOT NULL,
    date TEXT NOT NULL,
    seq INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    qty9 TEXT,
    notional9 TEXT,
    order_type TEXT NOT NULL,
    status TEXT NOT NULL,
    broker_order_id TEXT,
    skip_reason TEXT,
    submitted_ts TEXT,
    last_checked_ts TEXT,
    config_version TEXT,
    raw_response TEXT
  );
  CREATE INDEX idx_intents_date ON order_intents(date);

  -- Small key-value state: sleeve halts, last replayed activity id, brake tier, dial stage, etc.
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ts TEXT NOT NULL);
  `,
  // v2 — shared cross-sleeve tables (approvals queue + per-position metadata). Sleeve-PRIVATE
  // tables are owned by the sleeve modules themselves (CREATE TABLE IF NOT EXISTS at open), so
  // sleeve work never edits this file.
  `
  -- "Needs your call" queue (design §9): drift-watch flags, config amendment proposals, escalated
  -- thesis-checks. The dashboard renders pending rows; CJ resolves them; nothing auto-swaps.
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,          -- e.g. 'anchor-drift' | 'config-amendment' | 'thesis-escalation' | 'brake-tier3'
    title TEXT NOT NULL,
    payload TEXT NOT NULL,       -- JSON evidence blob
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
    resolved_ts TEXT,
    resolved_by TEXT
  );
  CREATE INDEX idx_approvals_status ON approvals(status);

  -- Per-position sleeve metadata: stop state (ratchet levels), exit horizons, thesis one-liners,
  -- invalidation levels, cluster/pick references. One row per (sleeve, symbol); JSON payload owned
  -- by the sleeve. Exits and the dashboard read it; reconcile clears rows for closed positions.
  CREATE TABLE position_meta (
    sleeve TEXT NOT NULL,
    symbol TEXT NOT NULL,
    meta TEXT NOT NULL,
    updated_ts TEXT NOT NULL,
    PRIMARY KEY (sleeve, symbol)
  );
  `,
];

export function openDb(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    const hasMeta = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get() as { name: string } | undefined;
    let v = 0;
    if (hasMeta) {
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
      v = row ? parseInt(row.value, 10) : 0;
    }
    for (let i = v; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(MIGRATIONS.length));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Key-value state helpers (sleeve halts, replay cursor, brake tier…). */
export function getState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM state WHERE key=?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}
export function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO state(key,value,updated_ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts",
  ).run(key, value, new Date().toISOString());
}
export function clearState(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM state WHERE key=?").run(key);
}
