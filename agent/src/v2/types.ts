// Bull v2 — shared types. The four sleeves + the book layer (design §1). Sleeve ids are SHORT because
// they lead every deterministic client_order_id ({sleeve}:{symbol}:{intent}:{yyyymmdd}:{seq} ≤ 48 chars).
export const SLEEVES = ["mom", "ins", "anc", "wld"] as const;
export type Sleeve = (typeof SLEEVES)[number];

/** "book" tags orders owned by the book layer itself (SGOV sweeps, brake trims) rather than a sleeve. */
export type OrderOwner = Sleeve | "book";

export const SLEEVE_NAMES: Record<OrderOwner, string> = {
  mom: "Momentum",
  ins: "Insider",
  anc: "Anchor",
  wld: "Wildcard",
  book: "Book",
};

/** Year-1 capital split (design §1) — evidence-weighted, fixed; year-2 reallocation is earned by data
 *  on schedule, never mid-quarter. Fractions of book equity. */
export const SLEEVE_SPLIT: Record<Sleeve, number> = { mom: 0.40, ins: 0.25, anc: 0.25, wld: 0.10 };

export type OrderIntent =
  | "buy"       // sleeve entry
  | "sell"      // sleeve exit (rank-out, manager-follow, horizon, reversal)
  | "stop"      // protective stop placement / stop-fire execution
  | "trim"      // partial reduce (dial trims, brake trims)
  | "sweep";    // SGOV cash sweep leg

export type IntentStatus =
  | "planned"     // intent recorded, not yet submitted
  | "submitted"   // POST sent, broker ack received
  | "unknown"     // POST outcome unknown (timeout) — MUST query by client_order_id before any resubmit
  | "skipped"     // gate refused it (no room / floor / blacklist) — terminal, with reason
  | `terminal:${string}`; // broker terminal status, e.g. terminal:filled / terminal:rejected

/** Reasons the order gateway refuses to submit (design §1/§4/§7). Logged, never silent. */
export type SkipReason =
  | "NO_SETTLED_CASH"        // settled-cash gate: buys never touch unsettled funds (GFV rail)
  | "BELOW_NOTIONAL_FLOOR"   // < $1 Alpaca notional floor (the v1 residual bug class)
  | "WASH_BLACKLIST"         // 31-day re-entry blacklist after a realized-loss exit (design §7)
  | "SKIP_NOT_FRACTIONABLE"  // asset not fractionable and whole-share fallback doesn't fit
  | "SLEEVE_HALTED"          // reconciliation mismatch halted this sleeve
  | "BRAKE"                  // graduated brake tier blocks new buys
  | "DAY_TRADE_GUARD";       // would be 4th day-trade in 5 rolling days (design §2)

/** Skips that mean "the book was BLOCKED", not "the trade was judged": cash parked in SGOV, or a
 *  reconciliation halt. A run refused for one of these was never adjudicated — no executed/done
 *  marker (momentum month, anchor rebuild, insider signal) may burn on it. The 08-24 halt week
 *  burned momentum's month AND anchor's rebuild on all-SLEEVE_HALTED runs; this is the shared
 *  guard every marker site now uses. */
export const BLOCKED_SKIPS: ReadonlySet<string> = new Set(["NO_SETTLED_CASH", "SLEEVE_HALTED"]);

/** True when an execute pass placed nothing and at least one refusal was a blocked-book condition —
 *  the caller must KEEP its marker/month/signal for retry instead of burning it. */
export function starvedNotVerdict(placedCount: number, skips: (string | null | undefined)[]): boolean {
  return placedCount === 0 && skips.some((s) => s != null && BLOCKED_SKIPS.has(s));
}
