// Bull v2 — Wildcard sleeve types (design §6). The sleeve is an LLM SECOND-OPINION concentrator:
// it never sources its own ideas — the pool is strictly names the system's OWN signals already
// surfaced (momentum top-25, live insider clusters incl. shadow-book, Anchor top-5s). Claude ranks
// that pool weekly; CODE buys the top 2–3. Everything the model touches crosses one of three PORTS
// below, so the LLM call, the sibling-sleeve reads, and the card data are all swappable — fixtures
// in tests, real adapters wired by the supervisor at integration time (Phase 3 owns LLM plumbing
// and the input quarantine).
import type { D9 } from "../../decimal.js";

// ---------------------------------------------------------------------------
// Pool — where candidate names come from. Reads SIBLING sleeve state only; the
// wildcard never invents a ticker (anti-hallucination rail: an out-of-pool
// ticker in a model response rejects the whole response).
// ---------------------------------------------------------------------------

export interface MomentumPoolRow { symbol: string; rank: number }
export interface InsiderPoolRow  { symbol: string; live: boolean } // live cluster vs shadow-book signal
export interface AnchorPoolRow   { symbol: string; managers: string[] }

export interface PoolPort {
  /** Current momentum ranking, best first (design pins the pool at the momentum top-25 —
   *  the sleeve's hold-band boundary). */
  momentumTop(n: number): Promise<MomentumPoolRow[]>;
  /** Live insider clusters INCLUDING shadow-book signals (funded or not — the signal is the point). */
  insiderLiveClusters(): Promise<InsiderPoolRow[]>;
  /** Every name currently in any Anchor manager's cloned top-5, with the manager list attached. */
  anchorTop5s(): Promise<AnchorPoolRow[]>;
}

/** One deduped pool candidate with its source flags — the flags travel onto the context card so the
 *  model sees WHY the system surfaced the name (insider/13F presence flags, design §6). */
export interface PoolEntry {
  symbol: string;
  momentumRank: number | null;
  insiderCluster: "live" | "shadow" | null;
  anchorManagers: string[];
}

// ---------------------------------------------------------------------------
// Card data — the three extractive feeds a context card is assembled from.
// NO RAW ARTICLE TEXT crosses this boundary (context-rot + injection findings,
// design §6): news arrives PRE-SCHEMATIZED as dated claims. The quarantined
// Haiku-class converter that produces claims from raw articles is Phase 3's —
// this type is the contract it must satisfy.
// ---------------------------------------------------------------------------

/** A single extractive, dated news claim. The shape IS the quarantine contract: {date, source,
 *  tickers, claim, number} — never prose, never a URL to fetch, never an instruction channel. */
export interface NewsClaim {
  date: string;            // YYYY-MM-DD the claim was published
  source: string;          // named outlet from the allowlist (EDGAR, market-data provider, …)
  tickers: string[];
  claim: string;           // one extractive sentence
  number?: string | number; // the load-bearing figure, when the claim has one
}

/** ~10-field fundamentals snapshot, dated. Values are display-ready strings/numbers — the card is
 *  model INPUT, not ledger math, so these are deliberately not d9. */
export interface FundamentalsSnapshot {
  asOf: string;                              // YYYY-MM-DD
  fields: Record<string, string | number>;   // e.g. mktCap, pe, revenueTtm, grossMarginPct, …
}

/** Price-path numbers — computed from bars, never model-estimated. */
export interface PricePath {
  asOf: string;      // YYYY-MM-DD
  last: number;
  chg1wPct: number;
  chg1mPct: number;
  chg3mPct: number;
  high52w: number;
  low52w: number;
  atr14: number;
}

export interface CardPort {
  fundamentals(symbol: string): Promise<FundamentalsSnapshot | null>;
  newsClaims(symbol: string): Promise<NewsClaim[]>;
  pricePath(symbol: string): Promise<PricePath | null>;
}

// ---------------------------------------------------------------------------
// The context card — schema-fixed, ≤2.5k tokens (config), extractive and dated.
// ---------------------------------------------------------------------------

export interface ContextCard {
  schema: "wld-card-v1";
  ticker: string;
  asOf: string;              // ET date key of the weekly run
  leiStage: string;          // the LEI regime string (book layer supplies)
  flags: {
    momentumRank: number | null;
    insiderCluster: "live" | "shadow" | null;
    anchorManagers: string[];
  };
  pricePath: PricePath | null;
  fundamentals: FundamentalsSnapshot | null;
  news: NewsClaim[];         // 3–5 dated claims, newest first
}

// ---------------------------------------------------------------------------
// Pick — the LLM call boundary. rankPool returns the RAW model output (string
// or already-parsed JSON) — validation is the caller's job, never the port's,
// so a lying adapter can't skip the schema check.
// ---------------------------------------------------------------------------

export interface PickPort {
  /** `schema` is the human-readable output-schema instruction embedded in the prompt; the fixture
   *  ignores it, the real (Phase 3) adapter forwards it into the Sonnet Batch request. */
  rankPool(cards: ContextCard[], schema: string): Promise<unknown>;
}

export const CONVICTION_BUCKETS = ["low", "medium", "high"] as const;
export type ConvictionBucket = (typeof CONVICTION_BUCKETS)[number];

/** Coarse horizon buckets — coarse ON PURPOSE: the model states an intent, code owns the clock
 *  (min-hold, cooldown, max-1-change are all enforced in churn.ts, never trusted to the model). */
export const HOLDING_PERIODS = ["weeks", "months", "quarters"] as const;
export type HoldingPeriod = (typeof HOLDING_PERIODS)[number];

/** One schema-valid pick. `invalidation_level` is the pre-written price level that voids the thesis
 *  — written by the model at PICK time, before it owns the position, which is exactly what makes it
 *  the anti-sycophancy asset for later thesis-checks (the judgment layer holds the model to a
 *  statement it made with no position to defend). */
export interface ValidatedPick {
  ticker: string;
  rank: number;
  conviction_bucket: ConvictionBucket;
  thesis: string;                     // ≤3 sentences
  invalidation_level: number;         // price > 0
  holding_period: HoldingPeriod;
  what_would_change_my_mind: string;
}

// ---------------------------------------------------------------------------
// Position metadata (position_meta.meta JSON for sleeve='wld') and the
// stop_fired handoff to the judgment layer.
// ---------------------------------------------------------------------------

export interface WldPosMeta {
  schema: "wld-pos-v1";
  thesis: string;
  invalidationLevel: number;          // ORIGINAL, from the pick — never rewritten
  conviction: ConvictionBucket;
  holdingPeriod: HoldingPeriod;
  whatWouldChangeMyMind: string;
  enteredOn: string;                  // ET date key the buy was placed
  pickRank: number;
  entryPrice: number;                 // estimate at placement; reconcile refines from fills
  peak: number;                       // ratchet high-water mark (only ever rises)
  atrStop: number | null;             // bot-side trailing stop (only ever rises)
  /** Set when an exit order was queued (swap/breach) — churn and stops both skip these rows. */
  pendingExit?: { reason: string; on: string };
  /** Set when a stop fired and the thesis-check handoff is pending — stops stop re-arming. */
  stopFired?: StopFiredEvent;
}

/** The judgment-layer handoff (design §6): written to state key `wld:stop_fired:<SYMBOL>` AND onto
 *  the position_meta row. Carries the ORIGINAL invalidation + thesis so the thesis-check judges the
 *  model against its own pre-written exit line. The −25%-from-entry hard floor is the judgment
 *  layer's code, not ours — we only hand over the facts. */
export interface StopFiredEvent {
  schema: "wld-stop-fired-v1";
  sleeve: "wld";
  symbol: string;
  firedTs: string;                    // ISO
  firedPrice: string;                 // d9 decimal string
  source: "bot_ratchet" | "broker_fill";
  entryPrice: number;
  peak: number;
  atrStop: number | null;
  thesis: string;
  invalidationLevel: number;
  whatWouldChangeMyMind: string;
  holdingPeriod: HoldingPeriod;
  enteredOn: string;
}

/** Daily OHLCV bar — structurally identical to src/alpaca.ts AlpacaBar so the real adapter can pass
 *  Alpaca bars straight through without a copy. */
export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }

/** Price lookup the run/stops engines take as a dependency (broker API at call time, never
 *  model-writable state — TradeTrap memory-poisoning finding, design §6). */
export type LatestPriceFn = (symbol: string) => Promise<number | null>;

export type { D9 };
