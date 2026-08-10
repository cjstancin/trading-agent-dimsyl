// Bull v2 — Wildcard REAL adapters. What's real vs stubbed, explicitly:
//   · PoolPort  — BEST-EFFORT reads of the sibling sleeves' expected private tables (mom_ranks /
//     ins_clusters / anc_clone). The siblings are being built CONCURRENTLY, so the shapes below are
//     assumptions the supervisor verifies at the integration seam; a missing table or column is an
//     EMPTY source, never a crash (the pool degrades to whatever signals exist).
//   · CardPort  — price-path is REAL (Alpaca daily bars, same free-tier data host as v1). The
//     fundamentals snapshot and pre-schematized news claims are Phase-3 TODOs: claims MUST come
//     from the quarantined converter ({date, source, tickers, claim, number} — never raw text), and
//     until that exists this adapter returns null/[] rather than smuggle prose in.
//   · PickPort  — STUB. Documents the Sonnet-class Batch API call; Phase 3 owns all LLM plumbing
//     (SDK wiring, batch polling, the quarantine) and replaces `sonnetBatchPickPort`.
import type { DatabaseSync } from "node:sqlite";
import { getBars, latestPrice } from "../../../alpaca.js";
import type {
  AnchorPoolRow, Bar, CardPort, InsiderPoolRow, MomentumPoolRow, PickPort, PoolPort, PricePath,
} from "./types.js";
import { computeAtr } from "./stops.js";

// ---------------------------------------------------------------------------
// PoolPort — sibling-table reader
// ---------------------------------------------------------------------------

/** Run one query, treating a missing table / unknown column as "no rows" — the sibling may not
 *  have shipped yet (or renamed a column since this was written; the seam test will catch it). */
function tryAll<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  try { return db.prepare(sql).all(...(params as any[])) as T[]; }
  catch { return []; }
}

/** Sibling-table shapes — SEAM-VERIFIED against the shipped sleeves (2026-08-10 integration pass):
 *   mom_ranks   (month, symbol, score, dollar_volume, fip, mom_rank, final_rank, veto)
 *               — monthly snapshots; current ranking = latest month, final_rank NOT NULL
 *                 (vetoed names carry NULL final_rank and must not enter the pool).
 *   ins_clusters(cluster_id, symbol, …, status, …) — live = status 'active'.
 *   anc_builds  (build_id, targets_json {symbol → weight9}, slots_json [ManagerSlot], …)
 *               — current clone book = latest build row; managers per symbol from slots' lines. */
export function siblingPoolPort(db: DatabaseSync): PoolPort {
  return {
    async momentumTop(n): Promise<MomentumPoolRow[]> {
      const rows = tryAll<{ symbol: string; rank: number }>(db,
        `SELECT symbol, final_rank AS rank FROM mom_ranks
         WHERE month = (SELECT MAX(month) FROM mom_ranks) AND final_rank IS NOT NULL
         ORDER BY final_rank ASC LIMIT ?`, n);
      return rows
        .map((r) => ({ symbol: String(r.symbol ?? "").toUpperCase(), rank: Number(r.rank) }))
        .filter((r) => r.symbol && Number.isFinite(r.rank));
    },
    async insiderLiveClusters(): Promise<InsiderPoolRow[]> {
      const rows = tryAll<{ symbol: string }>(db, "SELECT DISTINCT symbol FROM ins_clusters WHERE status='active'");
      return rows
        .map((r) => ({ symbol: String(r.symbol ?? "").toUpperCase(), live: true }))
        .filter((r) => r.symbol);
    },
    async anchorTop5s(): Promise<AnchorPoolRow[]> {
      const row = tryAll<{ targets_json: string; slots_json: string }>(db,
        "SELECT targets_json, slots_json FROM anc_builds ORDER BY build_id DESC LIMIT 1")[0];
      if (!row) return [];
      const bySym = new Map<string, string[]>();
      try {
        for (const sym of Object.keys(JSON.parse(row.targets_json) as Record<string, string>)) {
          bySym.set(sym.toUpperCase(), []);
        }
        const slots = JSON.parse(row.slots_json) as { manager?: string; lines?: { symbol?: string }[] }[];
        for (const slot of Array.isArray(slots) ? slots : []) {
          const mgr = String(slot.manager ?? "").trim();
          if (!mgr) continue;
          for (const line of slot.lines ?? []) {
            const sym = String(line.symbol ?? "").toUpperCase();
            const list = bySym.get(sym);
            if (list && !list.includes(mgr)) list.push(mgr);
          }
        }
      } catch { return []; }
      return [...bySym.entries()].map(([symbol, managers]) => ({ symbol, managers }));
    },
  };
}

// ---------------------------------------------------------------------------
// CardPort — Alpaca price-path; fundamentals/news deferred to Phase 3
// ---------------------------------------------------------------------------

const pct = (from: number, to: number): number =>
  from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : 0;

export function alpacaCardPort(): CardPort {
  return {
    /** TODO(Phase 3): fundamentals snapshot (~10 fields) from the EDGAR companyfacts cache the
     *  momentum sleeve's quality vetoes already maintain. Null until then — the card builder
     *  renders a fundamentals-less card rather than invent numbers. */
    async fundamentals() { return null; },

    /** TODO(Phase 3): pre-schematized claims from the QUARANTINED Haiku-class converter (source
     *  allowlist, schema-validated, imperatives dropped — design §6). Raw article text must never
     *  transit this port, so until the quarantine exists the answer is an empty list, full stop. */
    async newsClaims() { return []; },

    async pricePath(symbol): Promise<PricePath | null> {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 372 * 86_400_000).toISOString().slice(0, 10);
      const bars: Bar[] = await getBars(symbol, start, end, "1Day", 400);
      if (bars.length < 15) return null;   // not enough history for ATR(14) → no path, no card row
      const last = (await latestPrice(symbol)) ?? bars[bars.length - 1].c;
      const closeAgo = (days: number) => bars[Math.max(0, bars.length - 1 - days)].c;
      return {
        asOf: end,
        last,
        chg1wPct: pct(closeAgo(5), last),
        chg1mPct: pct(closeAgo(21), last),
        chg3mPct: pct(closeAgo(63), last),
        high52w: Math.max(...bars.map((b) => b.h)),
        low52w: Math.min(...bars.map((b) => b.l)),
        atr14: computeAtr(bars, 14) ?? 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// PickPort — Sonnet-class Batch API stub (Phase 3 wires the SDK)
// ---------------------------------------------------------------------------

/** The weekly ranking call, as designed (§6) and NOT yet wired:
 *   · Model: Sonnet-class, via the Message Batches API (the run is weekly and latency-free, and
 *     batch pricing halves the ~$4–7/mo all-in cost target; thesis-checks are Opus-class but those
 *     belong to the JUDGMENT layer, not this sleeve).
 *   · Request: one batch entry; system prompt = ranking role + the schema instruction passed in;
 *     user content = the ContextCard[] as JSON (cards only — fresh context every call, no memory
 *     of last week's reasoning, no CJ preferences, no verdict history).
 *   · Output: forced structured JSON (the PICK_SCHEMA_INSTRUCTION shape). The response is returned
 *     RAW — validate.ts is the only schema authority; this port never pre-parses or repairs.
 *   · Poll: batch results fetched by the scheduler; a failed/expired batch surfaces as a thrown
 *     error, which run.ts converts to a KEPT book (never a retry loop inside the port).
 *  Phase 3 replaces this stub alongside the quarantine wiring. */
export function sonnetBatchPickPort(): PickPort {
  return {
    async rankPool() {
      throw new Error("wld PickPort: Sonnet Batch adapter not wired — Phase 3 owns LLM plumbing + quarantine");
    },
  };
}
