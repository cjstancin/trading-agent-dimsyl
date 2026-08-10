// Bull v2 — momentum month-end ritual (design §2): signals at month-end close; orders happen later
// (first trading day, planner.ts). This is GLUE, not logic — every decision lives in the pure core
// (signal.ts) and every network touch goes through an injected port, so the whole ritual runs
// offline in tests with fixture ports. Steps:
//
//   1. build universe (Wikipedia ∩ Alpaca assets ∩ ≥13 month-end closes) → snapshot to mom_universe
//   2. scrape-breakage detector (>15% MoM delta → pending approvals row)
//   3. per name: month-end adjusted closes (12-1), formation-window dailies (FIP + dollar-volume
//      tiebreak), EDGAR fundamentals (CIK from the wiki table, else the SEC ticker map)
//   4. computeRanks → persist mom_ranks (REPLACE — idempotent re-runs)
//   5. advance both shadow books (shadow50 + live-N mirror)
//
// The returned RankResult.final is exactly what planner.planRebalance takes on rebalance morning.
import type { DatabaseSync } from "node:sqlite";
import { ensureMomTables } from "./schema.js";
import { buildUniverse, snapshotUniverse, universeDeltaCheck, type DeltaResult } from "./universe.js";
import { computeRanks, nFor, type RankResult, type SignalInput } from "./signal.js";
import { extractFundamentals } from "./edgar.js";
import { runShadowMonth } from "./shadow.js";
import { shiftMonth, type AssetsPort, type FundamentalsPort, type MomentumConfig, type PricePort, type UniversePort } from "./ports.js";

export interface MomPorts {
  universe: UniversePort;
  assets: AssetsPort;
  prices: PricePort;
  fundamentals: FundamentalsPort;
}

export interface MonthEndResult {
  month: string;
  universeCount: number;
  delta: DeltaResult;
  ranks: RankResult;
}

/** Run the full month-end signal pipeline for `month` ("YYYY-MM", the just-closed month).
 *  `sleeveUsd` sizes the mirror book's N (book layer supplies the sleeve slice of equity). */
export async function runMonthEnd(
  db: DatabaseSync, ports: MomPorts, cfg: MomentumConfig, month: string, sleeveUsd: number,
): Promise<MonthEndResult> {
  ensureMomTables(db);

  // 1–2: universe snapshot + breakage detector.
  const universe = await buildUniverse(ports, cfg);
  snapshotUniverse(db, month, universe);
  const delta = universeDeltaCheck(db, month, cfg);

  // 3: per-name signal inputs. Formation daily window = months (m−lookback … m−skip), i.e. the
  // exact span the 12-1 return is measured over — FIP smoothness must describe the SAME move.
  const { lookbackMonths, skipMonths } = cfg.signal;
  const needMonths = lookbackMonths + skipMonths + 1;
  const fmStart = `${shiftMonth(month, -lookbackMonths)}-01`;
  const fmEnd = `${shiftMonth(month, -(skipMonths - 1))}-01`;   // exclusive: dailies end where the skip begins

  const closesIndex = new Map<string, Map<string, number>>();
  const inputs: SignalInput[] = [];
  for (const u of universe) {
    const monthCloses = await ports.prices.monthEndCloses(u.symbol, needMonths);
    closesIndex.set(u.symbol, new Map(monthCloses.map((m) => [m.month, m.close])));

    const dailies = await ports.prices.dailyBars(u.symbol, fmStart, fmEnd);
    let pos = 0, neg = 0, rets = 0, dollarVol = 0;
    for (let i = 1; i < dailies.length; i++) {
      const r = dailies[i].close / dailies[i - 1].close - 1;
      rets++;
      if (r > 0) pos++; else if (r < 0) neg++;
    }
    const tail = dailies.slice(-21);   // ~1 month of sessions for the liquidity tiebreak
    if (tail.length) dollarVol = tail.reduce((a, b) => a + b.close * b.volume, 0) / tail.length;

    const cik = u.cik ?? (await ports.fundamentals.cikFor(u.symbol));
    const facts = cik ? await ports.fundamentals.companyfacts(cik) : null;

    inputs.push({
      symbol: u.symbol,
      closes: monthCloses.map((m) => m.close),
      dollarVolume: dollarVol,
      pctPosDays: rets ? pos / rets : 0,
      pctNegDays: rets ? neg / rets : 0,
      fundamentals: facts != null ? extractFundamentals(facts) : null,
      sector: u.sector,
    });
  }

  // 4: rank + persist the audit trail.
  const ranks = computeRanks(inputs, cfg);
  const finalRankBySymbol = new Map(ranks.final.map((r) => [r.symbol, r] as const));
  const vetoBySymbol = new Map(ranks.vetoed.map((v) => [v.symbol, v.reason] as const));
  const ins = db.prepare(
    `INSERT OR REPLACE INTO mom_ranks(month, symbol, score, dollar_volume, fip, mom_rank, final_rank, veto)
     VALUES(?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    for (const t of ranks.top) {
      const f = finalRankBySymbol.get(t.symbol);
      ins.run(month, t.symbol, t.score, t.dollarVolume, f?.fip ?? null, t.momRank, f?.finalRank ?? null, vetoBySymbol.get(t.symbol) ?? null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // 5: shadow books — same final ranks, two breadths.
  const finalSymbols = ranks.final.map((r) => r.symbol);
  runShadowMonth(db, "shadow50", month, finalSymbols, cfg.shadowN, closesIndex);
  runShadowMonth(db, "mirror", month, finalSymbols, nFor(cfg, sleeveUsd), closesIndex);

  return { month, universeCount: universe.length, delta, ranks };
}
