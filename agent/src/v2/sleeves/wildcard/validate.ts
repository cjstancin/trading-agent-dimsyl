// Bull v2 — Wildcard pick-response validation (design §6). HARD schema check on the model output.
// The rule is all-or-nothing: ONE invalid item rejects the WHOLE response and the book keeps last
// week's positions — partial application of a malformed pick set is how a hallucinated ticker or a
// missing invalidation level sneaks into the book half-checked. Rejection is a logged, normal
// outcome (wld_picks row, valid=0), never an exception.
//
// Checks, in order, per item:
//   ticker    — string, ∈ the EXACT pool sent to the model (anti-hallucination; held names were
//               excluded from that pool, so a model echoing a held name also rejects — held names
//               are not re-litigated, design §6)
//   rank      — integer ≥ 1, no duplicate ranks
//   conviction_bucket — enum low|medium|high
//   thesis    — non-empty, ≤3 sentences (counted, not trusted)
//   invalidation_level — finite number > 0 (the anti-sycophancy asset — absent = reject)
//   holding_period — enum weeks|months|quarters
//   what_would_change_my_mind — non-empty string
// Duplicate tickers reject. An empty array rejects (the model must rank SOMETHING or the response
// is malformed — "buy nothing" is expressed by code failing to find eligible picks, not by the model).
import {
  CONVICTION_BUCKETS, HOLDING_PERIODS,
  type ConvictionBucket, type HoldingPeriod, type ValidatedPick,
} from "./types.js";

export type ValidationResult =
  | { ok: true; picks: ValidatedPick[] }
  | { ok: false; reason: string };

/** Sentence count: terminal-punctuation runs followed by whitespace/end. Deliberately simple — the
 *  point is a hard ceiling the model can't argue with, not linguistic precision. "3." style decimals
 *  inside a sentence can over-count; the schema instruction tells the model to keep it short, and a
 *  false REJECT is the safe direction (book kept). */
export function sentenceCount(text: string): number {
  const parts = text.split(/[.!?]+(?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
  return parts.length;
}

export function validatePickResponse(raw: unknown, poolSymbols: Set<string>): ValidationResult {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); }
    catch { return { ok: false, reason: "malformed JSON" }; }
  }
  // Accept a bare array or a {picks: [...]} envelope (structured-output modes differ).
  const arr = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as any).picks) ? (parsed as any).picks
    : null;
  if (!arr) return { ok: false, reason: "response is not a pick array" };
  if (arr.length === 0) return { ok: false, reason: "empty pick array" };

  const picks: ValidatedPick[] = [];
  const seenTickers = new Set<string>();
  const seenRanks = new Set<number>();

  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const at = `pick[${i}]`;
    if (!p || typeof p !== "object") return { ok: false, reason: `${at}: not an object` };

    const ticker = typeof p.ticker === "string" ? p.ticker.toUpperCase().trim() : "";
    if (!ticker) return { ok: false, reason: `${at}: missing ticker` };
    if (!poolSymbols.has(ticker)) return { ok: false, reason: `${at}: ticker ${ticker} not in the sent pool` };
    if (seenTickers.has(ticker)) return { ok: false, reason: `${at}: duplicate ticker ${ticker}` };

    if (typeof p.rank !== "number" || !Number.isInteger(p.rank) || p.rank < 1)
      return { ok: false, reason: `${at}: rank must be an integer ≥ 1` };
    if (seenRanks.has(p.rank)) return { ok: false, reason: `${at}: duplicate rank ${p.rank}` };

    if (!CONVICTION_BUCKETS.includes(p.conviction_bucket))
      return { ok: false, reason: `${at}: conviction_bucket must be one of ${CONVICTION_BUCKETS.join("|")}` };

    if (typeof p.thesis !== "string" || !p.thesis.trim())
      return { ok: false, reason: `${at}: missing thesis` };
    const sentences = sentenceCount(p.thesis);
    if (sentences > 3) return { ok: false, reason: `${at}: thesis is ${sentences} sentences (max 3)` };

    if (typeof p.invalidation_level !== "number" || !Number.isFinite(p.invalidation_level) || p.invalidation_level <= 0)
      return { ok: false, reason: `${at}: invalidation_level must be a number > 0` };

    if (!HOLDING_PERIODS.includes(p.holding_period))
      return { ok: false, reason: `${at}: holding_period must be one of ${HOLDING_PERIODS.join("|")}` };

    if (typeof p.what_would_change_my_mind !== "string" || !p.what_would_change_my_mind.trim())
      return { ok: false, reason: `${at}: missing what_would_change_my_mind` };

    seenTickers.add(ticker);
    seenRanks.add(p.rank);
    picks.push({
      ticker,
      rank: p.rank,
      conviction_bucket: p.conviction_bucket as ConvictionBucket,
      thesis: p.thesis.trim(),
      invalidation_level: p.invalidation_level,
      holding_period: p.holding_period as HoldingPeriod,
      what_would_change_my_mind: p.what_would_change_my_mind.trim(),
    });
  }

  picks.sort((a, b) => a.rank - b.rank);
  return { ok: true, picks };
}
