// Bull v2 — graduated brake (design §2; replaces v1's hard halts). Measured on BOOK equity vs
// trailing peak, SGOV included. Tiers: −8% new buys size-halved · −11% no new buys (exits/stops/
// rebalance-sells still run) · −14% escalation. Recovery re-arms UPWARD through the same thresholds
// with a 2% hysteresis band so the brake never flaps around a threshold.
//
// Tier-3 semantics (deliberate): the design says "everything to cash except positions above their
// floors; needs-your-call escalation". Mass liquidation is exactly the kind of irreversible move
// that gets a human gate in this fleet — so tier 3 KEEPS the tier-2 buy freeze, auto-builds the
// liquidation plan (positions BELOW their protective floors sell via normal exit paths; healthy
// positions listed for CJ), and files it as a pending approval. The book never mass-liquidates
// without CJ's click.
import type { DatabaseSync } from "node:sqlite";
import { d9str } from "./../decimal.js";
import { getState, setState } from "./../db.js";

export type BrakeTier = 0 | 1 | 2 | 3;

export interface BrakeConfig {
  tiers: { ddPct: number; action: string }[]; // ascending severities: 8 / 11 / 14
  hysteresisPct: number;                      // 2
}

export interface BrakeState {
  tier: BrakeTier;
  ddPct: number;          // current drawdown from peak, positive number (e.g. 9.3)
  peak9: string;          // trailing peak equity (d9 string)
  sizeFactor: number;     // 1.0 | 0.5 | 0 — multiplier for NEW buys
  newBuysAllowed: boolean;
  escalate: boolean;      // true exactly when tier 3 is newly entered
}

/** Pure tier decision with hysteresis. Entering tier N needs dd ≥ tiers[N]; LEAVING tier N (moving
 *  down-tier) needs dd ≤ tiers[N] − hysteresis. In between, the previous tier sticks. */
export function decideTier(prevTier: BrakeTier, ddPct: number, cfg: BrakeConfig): BrakeTier {
  const t = cfg.tiers.map((x) => x.ddPct); // [8, 11, 14]
  let entered: BrakeTier = 0;
  for (let i = 0; i < t.length; i++) if (ddPct >= t[i]) entered = (i + 1) as BrakeTier;
  if (entered >= prevTier) return entered;                 // deeper (or equal) — take it immediately
  // Recovering: only re-arm below tier k if dd cleared its threshold by the hysteresis band.
  let tier = prevTier;
  while (tier > entered && ddPct <= t[tier - 1] - cfg.hysteresisPct) tier = (tier - 1) as BrakeTier;
  return tier;
}

const PEAK_KEY = "brake:peak9";
const TIER_KEY = "brake:tier";

/** Update the brake from today's book equity (d9). Persists peak + tier; returns the acting state.
 *  `escalate` fires exactly once per tier-3 entry — the caller files the approvals row + Discord. */
export function updateBrake(db: DatabaseSync, equity9: bigint, cfg: BrakeConfig): BrakeState {
  const prevPeak = BigInt(getState(db, PEAK_KEY) ?? "0");
  const peak = equity9 > prevPeak ? equity9 : prevPeak;
  setState(db, PEAK_KEY, peak.toString());

  const dd = peak > 0n ? Number(((peak - equity9) * 10_000n) / peak) / 100 : 0;
  const prevTier = Number(getState(db, TIER_KEY) ?? "0") as BrakeTier;
  const tier = decideTier(prevTier, dd, cfg);
  setState(db, TIER_KEY, String(tier));

  return {
    tier,
    ddPct: dd,
    peak9: d9str(peak),
    sizeFactor: tier === 0 ? 1.0 : tier === 1 ? 0.5 : 0,
    newBuysAllowed: tier <= 1,
    escalate: tier === 3 && prevTier < 3,
  };
}

/** Tier-3 liquidation PLAN (never auto-executed): positions below their protective floor go on the
 *  sell list (normal exit path); the rest are listed for CJ's call. floors = per-position floor
 *  price from position_meta (absent floor → listed, never auto-sold). */
export function tier3Plan(positions: { sleeve: string; symbol: string; price: number; floor?: number }[]): {
  autoSell: { sleeve: string; symbol: string; reason: string }[];
  needsCall: { sleeve: string; symbol: string; note: string }[];
} {
  const autoSell: { sleeve: string; symbol: string; reason: string }[] = [];
  const needsCall: { sleeve: string; symbol: string; note: string }[] = [];
  for (const p of positions) {
    if (p.floor != null && p.price < p.floor) autoSell.push({ sleeve: p.sleeve, symbol: p.symbol, reason: `below floor ${p.floor}` });
    else needsCall.push({ sleeve: p.sleeve, symbol: p.symbol, note: p.floor != null ? `above floor ${p.floor}` : "no floor recorded" });
  }
  return { autoSell, needsCall };
}
