// Bull v2 — Anchor: private persistence (anc_* tables, created here via IF NOT EXISTS — the shared
// db.ts migration chain is never touched by sleeve work). Two tables:
//
//   anc_filings — every parsed 13F we ever saw, keyed (cik, period, accession). Amendment law:
//     · 13F-HR/A amendmentType RESTATEMENT REPLACES the quarter's table → all earlier rows for the
//       (cik, period) get superseded=1 (Himalaya restated Q4'25 exactly this way);
//     · amendmentType NEW HOLDINGS is ADDITIVE (confidential-treatment reveals — Berkshire's
//       months-late drops) → rows concatenate with the original;
//     · an /A with NO declared type is treated as RESTATEMENT (the conservative SEC-guidance read).
//     The "current table" for a quarter = concat of all non-superseded rows' lines.
//
//   anc_builds — every clone build (targets + slots + flags), stamped with the config version so
//     any later order can be traced to the exact build that produced it.
//
// All bigints serialize as strings (JSON never sees a bigint — same rule as the shared ledger).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "../../decimal.js";
import type { FilingRecord, InfoTableLine, CloneBuild, ManagerSlot, ExcludedLine } from "./types.js";

export function ensureAnchorTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS anc_filings (
      cik TEXT NOT NULL,
      period TEXT NOT NULL,
      accession TEXT NOT NULL,
      form TEXT NOT NULL,
      amendment_type TEXT,
      filed_date TEXT NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0,
      lines_json TEXT NOT NULL,
      stored_ts TEXT NOT NULL,
      PRIMARY KEY (cik, period, accession)
    );
    CREATE INDEX IF NOT EXISTS idx_anc_filings_cik_period ON anc_filings(cik, period);

    CREATE TABLE IF NOT EXISTS anc_builds (
      build_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      period_tag TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      flags_json TEXT NOT NULL,
      total_weight9 TEXT NOT NULL,
      config_version TEXT NOT NULL,
      note TEXT
    );
  `);
}

// ---------- filings ----------

function linesToJson(lines: InfoTableLine[]): string {
  return JSON.stringify(lines.map((l) => ({ ...l, valueUsd: String(l.valueUsd), shares: String(l.shares) })));
}
function linesFromJson(json: string): InfoTableLine[] {
  return (JSON.parse(json) as any[]).map((l) => ({ ...l, valueUsd: BigInt(l.valueUsd), shares: BigInt(l.shares) }));
}

/** Store one parsed filing. Idempotent by (cik, period, accession). A RESTATEMENT (or untyped /A)
 *  supersedes every earlier row for the quarter. Returns what happened so the caller can decide
 *  whether a re-clone is warranted. */
export function storeFiling(db: DatabaseSync, rec: FilingRecord, lines: InfoTableLine[]): {
  inserted: boolean;
  restated: boolean;
} {
  ensureAnchorTables(db);
  const exists = db
    .prepare("SELECT accession FROM anc_filings WHERE cik=? AND period=? AND accession=?")
    .get(rec.cik, rec.period, rec.accession);
  if (exists) return { inserted: false, restated: false };

  const isAmendment = rec.form === "13F-HR/A";
  const restates = isAmendment && (rec.amendmentType ?? "RESTATEMENT").toUpperCase() !== "NEW HOLDINGS";

  db.exec("BEGIN");
  try {
    if (restates) {
      db.prepare("UPDATE anc_filings SET superseded=1 WHERE cik=? AND period=?").run(rec.cik, rec.period);
    }
    db.prepare(
      `INSERT INTO anc_filings(cik, period, accession, form, amendment_type, filed_date, superseded, lines_json, stored_ts)
       VALUES(?,?,?,?,?,?,0,?,?)`,
    ).run(rec.cik, rec.period, rec.accession, rec.form, rec.amendmentType ?? null, rec.filedDate,
      linesToJson(lines), new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { inserted: true, restated: restates };
}

/** The CURRENT table for (cik, period): concat of all non-superseded rows' lines (original +
 *  additive amendments, or just the latest restatement). Empty array = no filing stored. */
export function getCurrentLines(db: DatabaseSync, cik: string, period: string): InfoTableLine[] {
  ensureAnchorTables(db);
  const rows = db
    .prepare("SELECT lines_json FROM anc_filings WHERE cik=? AND period=? AND superseded=0 ORDER BY filed_date ASC, accession ASC")
    .all(cik, period) as { lines_json: string }[];
  const out: InfoTableLine[] = [];
  for (const r of rows) out.push(...linesFromJson(r.lines_json));
  return out;
}

/** Do we already have this accession? (the filing-evening loop's "anything new?" check) */
export function hasFiling(db: DatabaseSync, cik: string, period: string, accession: string): boolean {
  ensureAnchorTables(db);
  return !!db.prepare("SELECT 1 FROM anc_filings WHERE cik=? AND period=? AND accession=?").get(cik, period, accession);
}

/** Periods (desc) for which a manager has any stored filing — drives QoQ drift comparisons. */
export function storedPeriods(db: DatabaseSync, cik: string): string[] {
  ensureAnchorTables(db);
  const rows = db.prepare("SELECT DISTINCT period FROM anc_filings WHERE cik=? ORDER BY period DESC").all(cik) as { period: string }[];
  return rows.map((r) => r.period);
}

// ---------- builds ----------

function slotToJson(s: ManagerSlot): any {
  return {
    ...s,
    slotMass9: d9str(s.slotMass9),
    residual9: d9str(s.residual9),
    lines: s.lines.map((l) => ({ ...l, weight9: d9str(l.weight9), valueUsd: String(l.valueUsd) })),
    excluded: s.excluded.map((e) => ({ ...e, valueUsd: String(e.valueUsd) })),
  };
}
function slotFromJson(j: any): ManagerSlot {
  return {
    ...j,
    slotMass9: d9(j.slotMass9),
    residual9: d9(j.residual9),
    lines: j.lines.map((l: any) => ({ ...l, weight9: d9(l.weight9), valueUsd: BigInt(l.valueUsd) })),
    excluded: j.excluded.map((e: any) => ({ ...e, valueUsd: BigInt(e.valueUsd) })),
  };
}

export function storeBuild(db: DatabaseSync, build: CloneBuild, configVersion: string, note?: string): number {
  ensureAnchorTables(db);
  const targets: Record<string, string> = {};
  for (const [sym, w] of build.targets) targets[sym] = d9str(w);
  const res = db.prepare(
    `INSERT INTO anc_builds(ts, period_tag, targets_json, slots_json, flags_json, total_weight9, config_version, note)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    new Date().toISOString(), build.periodTag, JSON.stringify(targets),
    JSON.stringify(build.slots.map(slotToJson)),
    JSON.stringify(build.flags.map((f: ExcludedLine) => ({ ...f, valueUsd: String(f.valueUsd) }))),
    d9str(build.totalWeight9), configVersion, note ?? null,
  );
  return Number(res.lastInsertRowid);
}

export function loadBuild(db: DatabaseSync, buildId: number): (CloneBuild & { buildId: number }) | null {
  ensureAnchorTables(db);
  const row = db.prepare("SELECT * FROM anc_builds WHERE build_id=?").get(buildId) as any;
  return row ? rowToBuild(row) : null;
}

/** The most recent build (the planner's "previous targets" for the re-trade gate). */
export function latestBuild(db: DatabaseSync): (CloneBuild & { buildId: number }) | null {
  ensureAnchorTables(db);
  const row = db.prepare("SELECT * FROM anc_builds ORDER BY build_id DESC LIMIT 1").get() as any;
  return row ? rowToBuild(row) : null;
}

function rowToBuild(row: any): CloneBuild & { buildId: number } {
  const targets = new Map<string, D9>();
  for (const [sym, w] of Object.entries(JSON.parse(row.targets_json) as Record<string, string>)) targets.set(sym, d9(w));
  return {
    buildId: Number(row.build_id),
    periodTag: row.period_tag,
    targets,
    slots: (JSON.parse(row.slots_json) as any[]).map(slotFromJson),
    flags: (JSON.parse(row.flags_json) as any[]).map((f) => ({ ...f, valueUsd: BigInt(f.valueUsd) })),
    totalWeight9: d9(row.total_weight9),
  };
}

// ---------- approvals writes (shared table, sleeve-owned rows) ----------

/** Queue one approvals row. The anchor sleeve NEVER auto-acts on its own flags — CJ resolves them
 *  from the dashboard. Returns the approval id. */
export function queueApproval(db: DatabaseSync, kind: string, title: string, payload: unknown): number {
  const res = db.prepare("INSERT INTO approvals(ts, kind, title, payload, status) VALUES(?,?,?,?, 'pending')")
    .run(new Date().toISOString(), kind, title, JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  return Number(res.lastInsertRowid);
}
