// Bull v2 — LEI regime dial (design §2, CJ-locked). LEI stage → deployment scalar for NEW BUYS in
// Momentum + Wildcard only (engage 100% / caution 70% / pull-back 55%); Anchor and Insider are
// contrarian by design and exempt — they buy fear when their signals fire. On a stage DOWNGRADE the
// dial also trims those sleeves' excess through their normal exit paths (see trims.ts).
//
// Reading the stage: the LEI system lives on the same VPS and publishes a JSON payload; the adapter
// reads the file at BULL_LEI_STAGE_FILE and maps the LEI system's stage vocabulary through the
// config stageMap (finalized at launch against the live payload — an UNMAPPED stage counts as
// stale, never as a guess). Fallback chain (design): last-known stage honored ≤14 days, then Bill's
// own SPY 200-DMA filter (above → engage, below → pullback), always flagged in the digest.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getState, setState } from "./../db.js";
import type { Sleeve } from "./../types.js";

export type DialPosition = "engage" | "caution" | "pullback";

export interface DialConfig {
  stages: Record<DialPosition, number>;   // engage 1.0 / caution 0.7 / pullback 0.55
  appliesTo: Sleeve[];                    // ["mom","wld"]
  staleAfterDays: number;                 // 14
  stageMap: Record<string, string>;       // LEI vocabulary → DialPosition (+ _comment noise ok)
}

export interface LeiReading { stage: string; asOf: string /* YYYY-MM-DD or ISO */; }

export interface DialState {
  position: DialPosition;
  scalar: number;
  source: "lei" | "last-known" | "spy-200dma-fallback";
  leiStage?: string;
  asOf?: string;
  flags: string[];                        // digest-visible honesty notes
}

/** Real adapter: read the LEI payload file (same box). Returns null on any problem — the decision
 *  core treats null as "LEI unavailable" and walks the fallback chain. Accepts two shapes:
 *   · minimal {stage, asOf} (test/shim shape)
 *   · the REAL LEI build payload (verified on the box 2026-08-10, launch pre-check):
 *     /home/cj/lei/data/last_payload.json → {micro_stage: "WATCH|DEFENSIVE|CONFIRMED|RECOVERY",
 *     built_date: "YYYY-MM-DD", …} — the weekly Sunday refresh rewrites it atomically, so the
 *     14-day staleness window always holds unless the LEI refresh itself breaks (then: fallback,
 *     flagged in the digest, which is exactly the honest behavior the design asks for). */
export function readLeiFile(path = process.env.BULL_LEI_STAGE_FILE || ""): LeiReading | null {
  if (!path) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (typeof j?.stage === "string" && typeof j?.asOf === "string") return { stage: j.stage, asOf: j.asOf };
    if (typeof j?.micro_stage === "string" && typeof j?.built_date === "string") {
      return { stage: j.micro_stage, asOf: j.built_date };
    }
    return null;
  } catch { return null; }
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Pure decision core. `spyAbove200dma` is the offline-computable fallback signal (null = unknown →
 *  conservative pullback). Persists nothing — resolveDial() below owns state. */
export function decideDial(opts: {
  cfg: DialConfig;
  reading: LeiReading | null;
  lastKnown: { position: DialPosition; asOf: string } | null;
  today: string;               // YYYY-MM-DD
  spyAbove200dma: boolean | null;
}): DialState {
  const { cfg, reading, lastKnown, today, spyAbove200dma } = opts;
  const flags: string[] = [];

  if (reading) {
    const mapped = cfg.stageMap[reading.stage];
    if (mapped === "engage" || mapped === "caution" || mapped === "pullback") {
      const fresh = daysBetween(reading.asOf, today) <= cfg.staleAfterDays;
      if (fresh) {
        return { position: mapped, scalar: cfg.stages[mapped], source: "lei", leiStage: reading.stage, asOf: reading.asOf, flags };
      }
      flags.push(`LEI stage stale (${reading.asOf}) beyond ${cfg.staleAfterDays}d`);
    } else {
      flags.push(`LEI stage "${reading.stage}" unmapped — treated as unavailable`);
    }
  } else {
    flags.push("LEI payload unavailable");
  }

  // Last-known stage honored inside the staleness window.
  if (lastKnown && daysBetween(lastKnown.asOf, today) <= cfg.staleAfterDays) {
    flags.push(`running on last-known LEI stage from ${lastKnown.asOf}`);
    return { position: lastKnown.position, scalar: cfg.stages[lastKnown.position], source: "last-known", asOf: lastKnown.asOf, flags };
  }

  // SPY 200-DMA fallback — above → engage, below/unknown → pullback (conservative), always flagged.
  if (spyAbove200dma === true) {
    flags.push("fallback: SPY > 200-DMA → engage");
    return { position: "engage", scalar: cfg.stages.engage, source: "spy-200dma-fallback", flags };
  }
  flags.push(spyAbove200dma === false ? "fallback: SPY < 200-DMA → pullback" : "fallback signal unavailable → pullback (conservative)");
  return { position: "pullback", scalar: cfg.stages.pullback, source: "spy-200dma-fallback", flags };
}

const DIAL_KEY = "dial:lei";

/** Resolve today's dial, persist it, and report a stage CHANGE (the trims trigger). */
export function resolveDial(db: DatabaseSync, opts: {
  cfg: DialConfig; reading: LeiReading | null; today: string; spyAbove200dma: boolean | null;
}): DialState & { changed: boolean; previous?: DialPosition } {
  const prevRaw = getState(db, DIAL_KEY);
  const prev = prevRaw ? (JSON.parse(prevRaw) as { position: DialPosition; asOf: string }) : null;
  const state = decideDial({ ...opts, lastKnown: prev });
  const changed = prev !== null && prev.position !== state.position;
  setState(db, DIAL_KEY, JSON.stringify({ position: state.position, asOf: state.asOf ?? opts.today }));
  return { ...state, changed, previous: prev?.position };
}

/** Scalar for a sleeve: dial applies only to the configured sleeves; everyone else runs at 1.0. */
export function scalarFor(sleeve: Sleeve, dial: DialState, cfg: DialConfig): number {
  return cfg.appliesTo.includes(sleeve) ? dial.scalar : 1.0;
}

/** SPY 200-DMA from daily closes (needs ≥200 rows; latest last). Pure. */
export function spyAbove200(closes: number[]): boolean | null {
  if (closes.length < 200) return null;
  const tail = closes.slice(-200);
  const ma = tail.reduce((a, b) => a + b, 0) / 200;
  return closes[closes.length - 1] > ma;
}
