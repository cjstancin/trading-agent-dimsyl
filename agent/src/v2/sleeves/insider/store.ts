// Bull v2 insider sleeve — private tables (ins_*). Sleeve-private schema lives HERE via CREATE
// TABLE IF NOT EXISTS (the shared db.ts migration list is never edited by sleeve work — its own
// header says so). Three tables + an accession log:
//   ins_accessions — every accession we ever processed (or failed), so the 2–5-min Atom poll and
//                    the nightly daily-index reconciliation both dedupe on one ledger. The daily
//                    index repeats a filing once per FILER — dedupe by accession is load-bearing.
//   ins_filings    — one row per (accession × transaction), INCLUDING excluded transactions with
//                    their reason (the audit trail that lets us answer "why didn't KVHI fire?").
//                    4/A amendments never delete: they stamp superseded_by on the rows they replace.
//   ins_clusters   — detected clusters (participants as JSON), status active/dead/superseded.
//   ins_signals    — the shadow book: EVERY qualifying signal, funded or not, with CAR slots.
//                    40–100+ observations/yr vs 4–8 funded round trips — this is the honest
//                    evaluator; year-1 P&L cannot validate this sleeve.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "../../decimal.js";
import { classifyTxn, primaryOwner, txnValue9, type ParsedForm4 } from "./form4.js";
import type { BuyEvent, Cluster, OwnerHistoryFn } from "./cluster.js";

export function ensureInsiderTables(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS ins_accessions (
    accession TEXT PRIMARY KEY,
    form_type TEXT NOT NULL,
    issuer_cik TEXT,
    symbol TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    seen_ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ins_filings (
    accession TEXT NOT NULL,
    txn_key TEXT NOT NULL,
    document_type TEXT NOT NULL,
    issuer_cik TEXT NOT NULL,
    issuer_name TEXT,
    symbol TEXT NOT NULL,
    owner_cik TEXT NOT NULL,
    owner_name TEXT,
    is_officer INTEGER NOT NULL DEFAULT 0,
    is_director INTEGER NOT NULL DEFAULT 0,
    is_ten_pct INTEGER NOT NULL DEFAULT 0,
    is_other INTEGER NOT NULL DEFAULT 0,
    officer_title TEXT,
    trade_date TEXT NOT NULL,
    code TEXT NOT NULL,
    acquired_disposed TEXT,
    shares9 TEXT NOT NULL,
    price9 TEXT NOT NULL,
    value9 TEXT NOT NULL,
    shares_after9 TEXT,
    excluded_reason TEXT,
    superseded_by TEXT,
    filed_ts TEXT,
    PRIMARY KEY (accession, txn_key)
  );
  CREATE INDEX IF NOT EXISTS idx_ins_filings_symbol_date ON ins_filings(symbol, trade_date);
  CREATE INDEX IF NOT EXISTS idx_ins_filings_owner ON ins_filings(owner_cik, issuer_cik);
  CREATE TABLE IF NOT EXISTS ins_clusters (
    cluster_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    issuer_cik TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    insider_count INTEGER NOT NULL,
    officer_count INTEGER NOT NULL,
    director_count INTEGER NOT NULL,
    aggregate9 TEXT NOT NULL,
    score REAL NOT NULL,
    participants TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    detected_ts TEXT NOT NULL,
    config_version TEXT
  );
  CREATE TABLE IF NOT EXISTS ins_signals (
    signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    signal_date TEXT NOT NULL,
    entry_date TEXT,
    score REAL NOT NULL,
    funded INTEGER NOT NULL DEFAULT 0,
    skip_reason TEXT,
    slot_notional9 TEXT,
    client_order_id TEXT,
    entry_px9 TEXT,
    bench_entry_px9 TEXT,
    car21 REAL,
    car63 REAL,
    car126 REAL,
    created_ts TEXT NOT NULL
  );
  `);
}

/** "Seen" = successfully processed. An errored accession stays retryable — the next Atom poll or
 *  nightly reconcile takes another swing (bounded: one fetch per pass, under the 2 req/s cap). */
export function accessionSeen(db: DatabaseSync, accession: string): boolean {
  return !!db.prepare("SELECT 1 FROM ins_accessions WHERE accession=? AND status='processed'").get(accession);
}

export function logAccession(db: DatabaseSync, row: {
  accession: string; formType: string; issuerCik?: string; symbol?: string;
  source: string; status: "processed" | "error" | "skipped"; note?: string;
}): void {
  db.prepare(
    `INSERT INTO ins_accessions(accession, form_type, issuer_cik, symbol, source, status, note, seen_ts)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(accession) DO UPDATE SET status=excluded.status, note=excluded.note`,
  ).run(row.accession, row.formType, row.issuerCik ?? null, row.symbol ?? null,
    row.source, row.status, row.note ?? null, new Date().toISOString());
}

export interface StoreResult {
  inserted: number;
  qualifyingBuys: number;
  superseded: number;   // rows an amendment replaced
  symbol: string;
}

/** Store a parsed Form 4 (all transactions, excluded ones with their reason). Idempotent per
 *  (accession, txn_key). A 4/A supersedes by TRANSACTION KEY — (issuer, owner, trade_date, code) —
 *  stamping superseded_by on the earlier accession's matching rows; the caller then re-qualifies
 *  the cluster (exits.requalifyCluster) and a live position whose cluster dies gets a thesis-review
 *  flag, never an auto-sell. */
export function storeForm4(db: DatabaseSync, accession: string, f: ParsedForm4, filedTs: string | null): StoreResult {
  const owner = primaryOwner(f);
  if (!owner) throw new Error(`storeForm4 ${accession}: no reportingOwner`);

  const ins = db.prepare(
    `INSERT INTO ins_filings(accession, txn_key, document_type, issuer_cik, issuer_name, symbol,
       owner_cik, owner_name, is_officer, is_director, is_ten_pct, is_other, officer_title,
       trade_date, code, acquired_disposed, shares9, price9, value9, shares_after9,
       excluded_reason, filed_ts)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(accession, txn_key) DO NOTHING`,
  );

  let inserted = 0;
  let qualifying = 0;
  db.exec("BEGIN");
  try {
    for (let i = 0; i < f.txns.length; i++) {
      const t = f.txns[i];
      const cls = classifyTxn(f, t);
      const reason = cls.kind === "excluded" ? cls.reason : null;
      // txn_key: owner + trade date + code + ordinal. The ordinal keeps two same-day same-code
      // buys distinct; the (owner,date,code) prefix is what a 4/A supersedes by.
      const key = `${owner.cik}:${t.date}:${t.code}:${i}`;
      const res = ins.run(accession, key, f.documentType, f.issuerCik, f.issuerName, f.symbol,
        owner.cik, owner.name,
        owner.isOfficer ? 1 : 0, owner.isDirector ? 1 : 0, owner.isTenPercentOwner ? 1 : 0, owner.isOther ? 1 : 0,
        owner.officerTitle,
        t.date, t.code, t.acquiredDisposed, d9str(t.shares9), d9str(t.price9), d9str(txnValue9(t)),
        t.sharesAfter9 !== null ? d9str(t.sharesAfter9) : null,
        reason, filedTs);
      if (Number(res.changes) > 0) {
        inserted++;
        if (cls.kind === "buy") qualifying++;
      }
    }

    let superseded = 0;
    if (/^4\/A$/i.test(f.documentType)) {
      const upd = db.prepare(
        `UPDATE ins_filings SET superseded_by=?
         WHERE issuer_cik=? AND owner_cik=? AND trade_date=? AND code=?
           AND accession != ? AND superseded_by IS NULL`,
      );
      const keys = new Set(f.txns.map((t) => `${t.date}\u0000${t.code}`));
      for (const k of keys) {
        const [date, code] = k.split("\u0000");
        const res = upd.run(accession, f.issuerCik, owner.cik, date, code, accession);
        superseded += Number(res.changes);
      }
      db.exec("COMMIT");
      return { inserted, qualifyingBuys: qualifying, superseded, symbol: f.symbol };
    }
    db.exec("COMMIT");
    return { inserted, qualifyingBuys: qualifying, superseded: 0, symbol: f.symbol };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

interface FilingRow {
  accession: string; issuer_cik: string; symbol: string; owner_cik: string; owner_name: string;
  is_officer: number; is_director: number; is_ten_pct: number; officer_title: string | null;
  trade_date: string; shares9: string; value9: string; shares_after9: string | null;
}

/** Live qualifying buys (excluded/superseded rows out) as cluster-engine BuyEvents. */
export function qualifiedBuyEvents(db: DatabaseSync, opts: { symbol?: string; sinceDate?: string } = {}): BuyEvent[] {
  const conds = ["excluded_reason IS NULL", "superseded_by IS NULL", "code='P'"];
  const args: string[] = [];
  if (opts.symbol) { conds.push("symbol=?"); args.push(opts.symbol); }
  if (opts.sinceDate) { conds.push("trade_date>=?"); args.push(opts.sinceDate); }
  const rows = db.prepare(
    `SELECT * FROM ins_filings WHERE ${conds.join(" AND ")} ORDER BY trade_date ASC`,
  ).all(...args) as unknown as FilingRow[];
  return rows.map((r) => ({
    symbol: r.symbol,
    issuerCik: r.issuer_cik,
    ownerCik: r.owner_cik,
    ownerName: r.owner_name ?? "",
    isOfficer: !!r.is_officer,
    isDirector: !!r.is_director,
    isTenPercentOwner: !!r.is_ten_pct,
    officerTitle: r.officer_title,
    tradeDate: r.trade_date,
    shares9: d9(r.shares9),
    value9: d9(r.value9),
    sharesAfter9: r.shares_after9 !== null ? d9(r.shares_after9) : null,
  }));
}

/** History function for the cluster engine: prior P-buy trade dates per (owner, issuer) STRICTLY
 *  before `beforeDate`. Includes superseded rows on purpose — an amended buy still happened for
 *  routine-pattern purposes — but not excluded non-buys. */
export function ownerHistoryFn(db: DatabaseSync, issuerCik: string, beforeDate: string): OwnerHistoryFn {
  const stmt = db.prepare(
    `SELECT trade_date FROM ins_filings
     WHERE owner_cik=? AND issuer_cik=? AND code='P' AND excluded_reason IS NULL AND trade_date<?
     ORDER BY trade_date ASC`,
  );
  const cache = new Map<string, string[]>();
  return (ownerCik: string) => {
    let v = cache.get(ownerCik);
    if (!v) {
      v = (stmt.all(ownerCik, issuerCik, beforeDate) as { trade_date: string }[]).map((r) => r.trade_date);
      cache.set(ownerCik, v);
    }
    return v;
  };
}

/** Upsert a detected cluster (re-detection refreshes score/participants, keeps status). */
export function upsertCluster(db: DatabaseSync, c: Cluster, configVersion: string): void {
  db.prepare(
    `INSERT INTO ins_clusters(cluster_id, symbol, issuer_cik, window_start, window_end,
       insider_count, officer_count, director_count, aggregate9, score, participants, status,
       detected_ts, config_version)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
     ON CONFLICT(cluster_id) DO UPDATE SET
       window_start=excluded.window_start, window_end=excluded.window_end,
       insider_count=excluded.insider_count, officer_count=excluded.officer_count,
       director_count=excluded.director_count, aggregate9=excluded.aggregate9,
       score=excluded.score, participants=excluded.participants`,
  ).run(c.clusterId, c.symbol, c.issuerCik, c.windowStart, c.windowEnd,
    c.participants.length, c.officerCount, c.directorCount, d9str(c.aggregate9), c.score,
    JSON.stringify(c.participants), new Date().toISOString(), configVersion);
}

export interface ClusterRow {
  cluster_id: string; symbol: string; issuer_cik: string; window_start: string; window_end: string;
  insider_count: number; officer_count: number; director_count: number;
  aggregate9: string; score: number; participants: string; status: string;
}

export function getCluster(db: DatabaseSync, clusterId: string): ClusterRow | null {
  return (db.prepare("SELECT * FROM ins_clusters WHERE cluster_id=?").get(clusterId) as unknown as ClusterRow) ?? null;
}

export function setClusterStatus(db: DatabaseSync, clusterId: string, status: "active" | "dead" | "superseded"): void {
  db.prepare("UPDATE ins_clusters SET status=? WHERE cluster_id=?").run(status, clusterId);
}

/** Participant sells AFTER a cluster window — feeds reversal detection. Only open-market code S
 *  disposals count (classifyTxn stores those with a NULL excluded_reason as kind "sell"; F/G/M
 *  dispositions all carry an exclusion reason and never trip a reversal). */
export function participantSells(db: DatabaseSync, symbol: string, sinceDate: string, participantCiks: string[]): { ownerCik: string; shares9: D9 }[] {
  if (!participantCiks.length) return [];
  const q = participantCiks.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT owner_cik, shares9 FROM ins_filings
     WHERE symbol=? AND code='S' AND acquired_disposed='D'
       AND excluded_reason IS NULL AND superseded_by IS NULL
       AND trade_date>? AND owner_cik IN (${q})`,
  ).all(symbol, sinceDate, ...participantCiks) as { owner_cik: string; shares9: string }[];
  return rows.map((r) => ({ ownerCik: r.owner_cik, shares9: d9(r.shares9) }));
}
