// Bull v2 insider sleeve — entry planner (design capacity + selection). Signals qualify in the
// evening (Form 4s disseminate until 10pm ET); ENTRY is next market open. The planner splits into
// a PURE decision core (decideEntries — unit-tested hard against pre-fetched snapshots) and a thin
// I/O shell (gatherSnapshots + executeEntries) so every capacity/selection rule is testable
// offline. Capacity is EQUITY-INDEXED: slots = clamp(floor(sleeve$/500), 2, 8), slot size
// clamped to $300–600 — all four numbers from config (insider.capacity), never hardcoded.
//
// Selection when multiple clusters fire: sort by score (cluster.ts), then per candidate run the
// per-symbol gates (one-per-ticker, ≤2 same-sector, liquidity floor, spread gate) BEFORE consuming
// a slot — a candidate that fails its own gates must not burn a slot a lower-scored valid one
// could use. Everything that qualifies gets a shadow-book row either way (shadow.ts); full slots
// route the leftovers there with reason FULL_SLOTS.
import type { DatabaseSync } from "node:sqlite";
import { d9, div9, mul9, ONE9, type D9 } from "../../decimal.js";
import { placeOrder } from "../../order-gateway.js";
import type { BrokerPort } from "../../broker.js";
import type { Cluster } from "./cluster.js";
import { passesLiquidityFloor, spreadOk, type LiquidityCfg } from "./liquidity.js";
import type { AssetInfo, DailyBar, MarketPort, Quote, SectorPort } from "./ports.js";
import { markFunded, markShadow, recordSignal } from "./shadow.js";
import { addMonths, readMeta, tryClockReset, writeMeta, type InsPositionMeta } from "./exits.js";
import { upsertCluster } from "./store.js";

export interface CapacityCfg {
  slotFloorUsd: number;
  slotCeilUsd: number;
  slotsPerUsd: number;
  slotsMin: number;
  slotsMax: number;
  maxSameSector: number;
}

/** slots = clamp(floor(sleeve$ / slotsPerUsd), slotsMin, slotsMax). */
export function slotCount(sleeveUsd: number, cap: CapacityCfg): number {
  const raw = Math.floor(sleeveUsd / cap.slotsPerUsd);
  return Math.min(Math.max(raw, cap.slotsMin), cap.slotsMax);
}

/** Per-slot notional, clamped to [$floor, $ceil]. d9 result — this is money. */
export function slotNotional9(sleeveUsd: number, cap: CapacityCfg): D9 {
  const slots = slotCount(sleeveUsd, cap);
  const per = sleeveUsd / slots;
  const clamped = Math.min(Math.max(per, cap.slotFloorUsd), cap.slotCeilUsd);
  return d9(clamped.toFixed(6));
}

export interface CandidateSnapshot {
  cluster: Cluster;
  bars: DailyBar[];
  quote: Quote | null;
  marketCap9: D9 | null;
  asset: AssetInfo | null;
  sector: string | null;
}

export interface HeldPosition { symbol: string; sector: string | null }

export type EntryDecision =
  | { kind: "fund"; symbol: string; clusterId: string; sector: string | null; notional9: D9; estPrice9: D9 }
  | { kind: "fund-whole"; symbol: string; clusterId: string; sector: string | null; qty9: D9; limitPrice9: D9 }
  | { kind: "shadow"; symbol: string; clusterId: string; reason: string };

/** Quote mid (d9). */
export function mid9(q: Quote): D9 {
  return (q.bid9 + q.ask9) / 2n;
}

/** PURE decision core. Candidates arrive score-ordered or not — we sort. Gate order per candidate:
 *  one-per-ticker → sector cap → liquidity floor → spread gate → tradability → slot availability →
 *  fractionable-or-fallback. First failure is the recorded reason. */
export function decideEntries(
  snaps: CandidateSnapshot[],
  held: HeldPosition[],
  sleeveUsd: number,
  cap: CapacityCfg,
  liq: LiquidityCfg,
): EntryDecision[] {
  const decisions: EntryDecision[] = [];
  const heldSymbols = new Set(held.map((h) => h.symbol));
  const sectorCounts = new Map<string, number>();
  for (const h of held) if (h.sector) sectorCounts.set(h.sector, (sectorCounts.get(h.sector) ?? 0) + 1);

  let slotsFree = Math.max(slotCount(sleeveUsd, cap) - held.length, 0);
  const notional9 = slotNotional9(sleeveUsd, cap);

  const ordered = [...snaps].sort((a, b) => b.cluster.score - a.cluster.score);
  for (const s of ordered) {
    const sym = s.cluster.symbol;
    const shadow = (reason: string): void => {
      decisions.push({ kind: "shadow", symbol: sym, clusterId: s.cluster.clusterId, reason });
    };

    if (heldSymbols.has(sym)) { shadow("ALREADY_HELD"); continue; }

    // Sector cap: unknown sectors never count toward (or against) the cap — we can't prove two
    // unknowns match, and a null-sector pile-up blocking real entries would be a silent bug.
    if (s.sector && (sectorCounts.get(s.sector) ?? 0) >= cap.maxSameSector) { shadow("SECTOR_CAP"); continue; }

    const price9 = s.quote ? mid9(s.quote) : (s.bars.length ? s.bars[s.bars.length - 1].close9 : null);
    const floor = passesLiquidityFloor({
      bars: s.bars, price9, marketCap9: s.marketCap9, exchange: s.asset?.exchange ?? null,
    }, liq);
    if (!floor.ok) { shadow(floor.reason); continue; }

    if (!s.quote || !spreadOk(s.quote.bid9, s.quote.ask9, liq.maxSpreadPct)) { shadow("SPREAD_GATE"); continue; }
    if (!s.asset || !s.asset.tradable) { shadow("NOT_TRADABLE"); continue; }

    if (slotsFree <= 0) { shadow("FULL_SLOTS"); continue; }

    const px = mid9(s.quote);
    if (s.asset.fractionable) {
      decisions.push({ kind: "fund", symbol: sym, clusterId: s.cluster.clusterId, sector: s.sector, notional9, estPrice9: px });
    } else {
      // Whole-share limit-at-mid fallback: floor(slot$ / mid) shares. Zero shares → the slot can't
      // express the position at all → SKIP_NOT_FRACTIONABLE (recorded, never silent).
      const qty9 = (div9(notional9, px) / ONE9) * ONE9;
      if (qty9 < ONE9) { shadow("SKIP_NOT_FRACTIONABLE"); continue; }
      decisions.push({ kind: "fund-whole", symbol: sym, clusterId: s.cluster.clusterId, sector: s.sector, qty9, limitPrice9: px });
    }
    slotsFree--;
    heldSymbols.add(sym);
    if (s.sector) sectorCounts.set(s.sector, (sectorCounts.get(s.sector) ?? 0) + 1);
  }
  return decisions;
}

/** Fetch the per-candidate market snapshot (I/O shell around the pure core). */
export async function gatherSnapshots(
  market: MarketPort, sector: SectorPort, clusters: Cluster[], lookbackDays = 45,
): Promise<CandidateSnapshot[]> {
  const out: CandidateSnapshot[] = [];
  for (const c of clusters) {
    out.push({
      cluster: c,
      bars: await market.getDailyBars(c.symbol, lookbackDays),
      quote: await market.getQuote(c.symbol),
      marketCap9: await market.getMarketCap9(c.symbol, c.issuerCik),
      asset: await market.getAsset(c.symbol),
      sector: await sector.getSector(c.symbol),
    });
  }
  return out;
}

/** Symbols the ins sleeve currently holds (ledger truth: lots, not broker positions). */
export function insHeld(db: DatabaseSync): { symbol: string; sector: string | null }[] {
  const rows = db.prepare(
    "SELECT symbol, SUM(CAST(qty_remaining9 AS REAL)) AS q FROM lots WHERE sleeve='ins' GROUP BY symbol",
  ).all() as { symbol: string; q: number }[];
  return rows.filter((r) => r.q > 0).map((r) => ({ symbol: r.symbol, sector: readMeta(db, r.symbol)?.sector ?? null }));
}

export interface ExecutedEntry {
  symbol: string;
  clusterId: string;
  outcome: "placed" | "shadow" | "gateway-skip" | "clock-reset";
  reason?: string;
  clientOrderId?: string;
}

/** Execute decisions: every qualifying cluster gets its shadow-book row; funded ones go through
 *  THE order gateway (the only order path); an ALREADY_HELD signal attempts the one-time clock
 *  reset instead of adding capital (design: reset once, max 9 months, no added capital). */
export async function executeEntries(db: DatabaseSync, broker: BrokerPort, opts: {
  clusters: Cluster[];
  decisions: EntryDecision[];
  signalDate: string;       // evening the cluster qualified
  entryDate: string;        // next market open session (asOfDate for the gateway)
  configVersion: string;
  washBlacklistDays: number;
  horizonTradingDays: number;
  clusterResetMaxMonths: number;
  benchEntryPx9: D9 | null; // IWM reference at entry, for CAR math
}): Promise<ExecutedEntry[]> {
  const byId = new Map(opts.clusters.map((c) => [c.clusterId, c]));
  const out: ExecutedEntry[] = [];

  for (const c of opts.clusters) {
    upsertCluster(db, c, opts.configVersion);
    recordSignal(db, c, opts.signalDate);
  }

  for (const d of opts.decisions) {
    const cluster = byId.get(d.clusterId);
    if (!cluster) continue;

    if (d.kind === "shadow") {
      // ALREADY_HELD is special: a NEW qualifying cluster on a held name resets the horizon clock
      // once (no added capital). Shadow row still records the signal.
      if (d.reason === "ALREADY_HELD") {
        const meta = readMeta(db, d.symbol);
        if (meta) {
          const reset = tryClockReset(meta, opts.entryDate);
          if (reset) {
            writeMeta(db, d.symbol, reset);
            markShadow(db, d.clusterId, { reason: "ALREADY_HELD_CLOCK_RESET", entryDate: opts.entryDate, entryPx9: null, benchEntryPx9: null });
            out.push({ symbol: d.symbol, clusterId: d.clusterId, outcome: "clock-reset" });
            continue;
          }
        }
      }
      markShadow(db, d.clusterId, { reason: d.reason, entryDate: opts.entryDate, entryPx9: null, benchEntryPx9: opts.benchEntryPx9 });
      out.push({ symbol: d.symbol, clusterId: d.clusterId, outcome: "shadow", reason: d.reason });
      continue;
    }

    const place = await placeOrder(db, broker, d.kind === "fund" ? {
      owner: "ins", symbol: d.symbol, intent: "buy", side: "buy", type: "market", tif: "day",
      notional9: d.notional9, asOfDate: opts.entryDate, configVersion: opts.configVersion,
    } : {
      owner: "ins", symbol: d.symbol, intent: "buy", side: "buy", type: "limit", tif: "day",
      qty9: d.qty9, limitPrice9: d.limitPrice9, asOfDate: opts.entryDate, configVersion: opts.configVersion,
    }, { washBlacklistDays: opts.washBlacklistDays });

    if (!place.placed) {
      const reason = place.skipped ?? "GATEWAY_REJECTED";
      markShadow(db, d.clusterId, { reason, entryDate: opts.entryDate, entryPx9: null, benchEntryPx9: opts.benchEntryPx9 });
      out.push({ symbol: d.symbol, clusterId: d.clusterId, outcome: "gateway-skip", reason, clientOrderId: place.clientOrderId });
      continue;
    }

    const entryPx9 = d.kind === "fund" ? d.estPrice9 : d.limitPrice9;
    const notional9 = d.kind === "fund" ? d.notional9 : mul9(d.qty9, d.limitPrice9);
    markFunded(db, d.clusterId, {
      entryDate: opts.entryDate, slotNotional9: notional9, entryPx9,
      benchEntryPx9: opts.benchEntryPx9, clientOrderId: place.clientOrderId,
    });
    const meta: InsPositionMeta = {
      clusterId: d.clusterId,
      entryDate: opts.entryDate,
      horizonTradingDays: opts.horizonTradingDays,
      clockResets: 0,
      maxExitDate: addMonths(opts.entryDate, opts.clusterResetMaxMonths),
      sector: d.sector,
      participants: cluster.participants.map((p) => ({ cik: p.cik, name: p.name, shares9: p.shares9 })),
    };
    writeMeta(db, d.symbol, meta);
    out.push({ symbol: d.symbol, clusterId: d.clusterId, outcome: "placed", clientOrderId: place.clientOrderId });
  }
  return out;
}
