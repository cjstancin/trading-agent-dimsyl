// Bull v2 — momentum universe (design §2). S&P 500 + S&P 400 constituents (Wikipedia) ∩ Alpaca
// assets (active, tradable, fractionable) ∩ names with ≥13 month-end closes of history. The monthly
// snapshot into mom_universe is the point: Wikipedia only shows TODAY's index, so persisting each
// month builds our own survivorship-free archive — future backtests replay the book as it actually
// was, not as the survivors remember it.
//
// Scrape-breakage detector: Wikipedia edits break scrapers silently, and a half-parsed page looks
// exactly like a mass index reconstitution. A month-over-month symbol delta >15% (config) files an
// approvals row (kind 'mom-universe-delta', pending) instead of trading on garbage — CJ adjudicates.
import type { DatabaseSync } from "node:sqlite";
import { getState, setState } from "../../db.js";
import { ensureMomTables } from "./schema.js";
import type { AssetsPort, MomentumConfig, PricePort, UniversePort, WikiConstituent } from "./ports.js";

export interface UniverseRow {
  symbol: string;
  sector: string;
  cik: string | null;
  list: "sp500" | "sp400";
}

/** Build this month's tradable universe through the ports. Sequential on purpose — the real price
 *  adapter is rate-limit-friendly, and month-end has hours of slack. Throws if the scrape came back
 *  empty (a silent empty universe would liquidate the book). */
export async function buildUniverse(
  ports: { universe: UniversePort; assets: AssetsPort; prices: PricePort },
  cfg: MomentumConfig,
): Promise<UniverseRow[]> {
  const cons = await ports.universe.fetchConstituents();
  const wanted = cons.filter((c) => (c.list === "sp500" ? cfg.universe.sp500 : cfg.universe.sp400));
  if (!wanted.length) throw new Error("buildUniverse: constituent scrape returned nothing — refusing an empty universe");

  // De-dupe by symbol (the two indices are disjoint by construction; belt and suspenders).
  const bySymbol = new Map<string, WikiConstituent>();
  for (const c of wanted) if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, c);

  const assets = await ports.assets.fetchActiveAssets();
  const out: UniverseRow[] = [];
  for (const c of bySymbol.values()) {
    const a = assets.get(c.symbol);
    if (!a || !a.tradable || !a.fractionable) continue;
    const closes = await ports.prices.monthEndCloses(c.symbol, cfg.universe.minMonthEndCloses + 2);
    if (closes.length < cfg.universe.minMonthEndCloses) continue;
    out.push({ symbol: c.symbol, sector: c.sector, cik: c.cik, list: c.list });
  }
  out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return out;
}

/** Persist the month's snapshot. Idempotent: REPLACE by (month, symbol); a re-run with the same
 *  rows changes nothing, a re-run with corrected rows fixes them in place. */
export function snapshotUniverse(db: DatabaseSync, month: string, rows: UniverseRow[]): { total: number } {
  ensureMomTables(db);
  const ins = db.prepare(
    "INSERT OR REPLACE INTO mom_universe(month, symbol, sector, cik, list) VALUES(?,?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) ins.run(month, r.symbol, r.sector, r.cik, r.list);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const n = db.prepare("SELECT COUNT(*) AS n FROM mom_universe WHERE month=?").get(month) as { n: number };
  return { total: Number(n.n) };
}

export function universeSymbols(db: DatabaseSync, month: string): string[] {
  const rows = db.prepare("SELECT symbol FROM mom_universe WHERE month=? ORDER BY symbol").all(month) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

export interface DeltaResult {
  prevMonth: string | null;
  deltaPct: number;      // (added + removed) / previous count × 100
  added: string[];
  removed: string[];
  alerted: boolean;      // an approvals row was filed (this call or a prior one this month)
}

/** Compare this month's snapshot to the most recent PRIOR snapshot. Over-threshold delta files ONE
 *  pending approvals row per month (state-key guarded — re-runs don't spam the queue). First-ever
 *  month has no baseline → no alert by definition. */
export function universeDeltaCheck(db: DatabaseSync, month: string, cfg: MomentumConfig): DeltaResult {
  ensureMomTables(db);
  const prev = db
    .prepare("SELECT DISTINCT month FROM mom_universe WHERE month < ? ORDER BY month DESC LIMIT 1")
    .get(month) as { month: string } | undefined;
  if (!prev) return { prevMonth: null, deltaPct: 0, added: [], removed: [], alerted: false };

  const cur = new Set(universeSymbols(db, month));
  const old = new Set(universeSymbols(db, prev.month));
  const added = [...cur].filter((s) => !old.has(s)).sort();
  const removed = [...old].filter((s) => !cur.has(s)).sort();
  const deltaPct = old.size === 0 ? 100 : ((added.length + removed.length) / old.size) * 100;

  const over = deltaPct > cfg.universe.universeDeltaAlertPct;
  const guardKey = `mom:universe-delta-alerted:${month}`;
  let alerted = getState(db, guardKey) != null;
  if (over && !alerted) {
    db.prepare("INSERT INTO approvals(ts, kind, title, payload) VALUES(?,?,?,?)").run(
      new Date().toISOString(),
      "mom-universe-delta",
      `Momentum universe moved ${deltaPct.toFixed(1)}% MoM (${prev.month} → ${month}) — scrape breakage or reconstitution?`,
      JSON.stringify({
        month, prevMonth: prev.month, deltaPct: Number(deltaPct.toFixed(2)),
        prevCount: old.size, curCount: cur.size,
        added: added.slice(0, 60), removed: removed.slice(0, 60),  // capped: evidence, not a dump
      }),
    );
    setState(db, guardKey, new Date().toISOString());
    alerted = true;
  }
  return { prevMonth: prev.month, deltaPct, added, removed, alerted: over && alerted };
}
