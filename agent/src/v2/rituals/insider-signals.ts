// Bull v2 — rituals: insider signal glue. The sleeve owns parsing/storage/cluster math; the
// rituals own WHEN detection runs and how a "signal tonight, entry next open" travels:
//   · scanNewInsiderSignals — after any ingest pass (poll tick, nightly reconcile), re-detect
//     clusters over the recent qualified-buy window and record any NEW ones into ins_signals
//     (recordSignal is idempotent by cluster_id, so re-detection can't double-count).
//   · pendingEntrySignals — the morning pipeline's queue: signals with no entry_date whose cluster
//     is still ACTIVE (a 4/A that killed the cluster removes it from the queue by status).
import type { DatabaseSync } from "node:sqlite";
import { d9 } from "../decimal.js";
import { addDays } from "../lots.js";
import { detectClusters, type Cluster, type ClusterCfg } from "../sleeves/insider/cluster.js";
import { ensureInsiderTables, qualifiedBuyEvents, ownerHistoryFn, upsertCluster } from "../sleeves/insider/store.js";
import { recordSignal } from "../sleeves/insider/shadow.js";

/** Re-detect clusters over the trailing window and record the NEW ones. Returns only clusters
 *  whose ins_signals row was just created (the Discord-worthy news). Detection runs per symbol so
 *  each symbol gets its issuer's owner-history function (routine-buyer screen + first-ever). */
export function scanNewInsiderSignals(
  db: DatabaseSync, clusterCfg: ClusterCfg, today: string, configVersion: string,
): Cluster[] {
  ensureInsiderTables(db);
  const since = addDays(today, -(clusterCfg.windowDays + 5)); // window + dissemination slack
  const buys = qualifiedBuyEvents(db, { sinceDate: since });
  const bySymbol = new Map<string, typeof buys>();
  for (const b of buys) {
    const arr = bySymbol.get(b.symbol) ?? [];
    arr.push(b);
    bySymbol.set(b.symbol, arr);
  }

  const fresh: Cluster[] = [];
  for (const [, symBuys] of bySymbol) {
    const history = ownerHistoryFn(db, symBuys[0].issuerCik, since);
    for (const c of detectClusters(symBuys, history, clusterCfg)) {
      // A cluster an amendment already killed must not resurrect through re-detection.
      const status = db.prepare("SELECT status FROM ins_clusters WHERE cluster_id=?").get(c.clusterId) as
        | { status: string } | undefined;
      if (status && status.status !== "active") continue;
      upsertCluster(db, c, configVersion);
      if (recordSignal(db, c, today)) fresh.push(c);
    }
  }
  return fresh;
}

export interface PendingEntry { cluster: Cluster; signalDate: string }

/** Signals awaiting their next-open entry: entry_date IS NULL and the cluster is still active. */
export function pendingEntrySignals(db: DatabaseSync): PendingEntry[] {
  ensureInsiderTables(db);
  const rows = db.prepare(
    `SELECT s.cluster_id, s.signal_date FROM ins_signals s
     JOIN ins_clusters c ON c.cluster_id = s.cluster_id
     WHERE s.entry_date IS NULL AND c.status = 'active'
     ORDER BY s.signal_date ASC`,
  ).all() as { cluster_id: string; signal_date: string }[];
  const out: PendingEntry[] = [];
  for (const r of rows) {
    const cluster = loadClusterById(db, r.cluster_id);
    if (cluster) out.push({ cluster, signalDate: r.signal_date });
  }
  return out;
}

/** Rebuild a full Cluster object from its ins_clusters row (participants ride as JSON). */
export function loadClusterById(db: DatabaseSync, clusterId: string): Cluster | null {
  const r = db.prepare("SELECT * FROM ins_clusters WHERE cluster_id=?").get(clusterId) as
    | {
        cluster_id: string; symbol: string; issuer_cik: string; window_start: string; window_end: string;
        officer_count: number; director_count: number; aggregate9: string; score: number; participants: string;
      }
    | undefined;
  if (!r) return null;
  return {
    clusterId: r.cluster_id,
    symbol: r.symbol,
    issuerCik: r.issuer_cik,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    participants: JSON.parse(r.participants),
    aggregate9: d9(r.aggregate9),
    officerCount: r.officer_count,
    directorCount: r.director_count,
    score: r.score,
  };
}
