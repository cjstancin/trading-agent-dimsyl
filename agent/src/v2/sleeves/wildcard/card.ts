// Bull v2 — Wildcard context-card builder (design §6). PURE assembly of the schema-fixed,
// ≤2.5k-token (config) per-name card the model ranks from. Three rails live here:
//   1. EXTRACTIVE ONLY — news enters as pre-schematized dated claims ({date, source, tickers,
//      claim, number}); a claim missing its date/source/claim text is DROPPED, not repaired.
//      Raw article text never reaches a decision call (context-rot + injection findings).
//   2. TOKEN BUDGET — estimated at 4 chars/token over the serialized card. Over-budget cards are
//      truncated EXTRACTIVELY in a fixed priority order, whole units at a time (a claim is dropped
//      entire, never cut mid-claim — half a claim is a fabrication surface):
//        news claims beyond 3 (oldest first) → fundamentals fields beyond a 5-field core (last
//        first) → remaining claims (oldest first) → the whole fundamentals block.
//      The irreducible core (ticker/flags/pricePath/LEI stage) exceeding the budget throws — that's
//      a config error, not a truncation case.
//   3. EVERY CLAIM DATED — the model must be able to weigh staleness; undated claims are dropped
//      by rail 1, and fundamentals/pricePath carry their own asOf stamps.
import type { ContextCard, FundamentalsSnapshot, NewsClaim, PoolEntry, PricePath } from "./types.js";

export const CHARS_PER_TOKEN = 4;       // the design's stated estimate — deliberate, not tuned
export const NEWS_MAX = 5;              // schema: 3–5 dated claims
export const NEWS_PREFERRED_MIN = 3;    // truncation keeps ≥3 while other fat remains
export const FUNDAMENTALS_MAX = 12;     // "~10 fields" — hard cap so a chatty adapter can't bloat
export const FUNDAMENTALS_CORE = 5;     // truncation floor before claims start going below 3

export function estimateTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v).length / CHARS_PER_TOKEN);
}

export interface CardInputs {
  entry: PoolEntry;
  fundamentals: FundamentalsSnapshot | null;
  news: NewsClaim[];
  pricePath: PricePath | null;
  leiStage: string;
  asOf: string;              // ET date key of the run
}

export interface BuiltCard {
  card: ContextCard;
  tokens: number;
  dropped: string[];         // audit: what truncation removed, e.g. "news:2026-07-01:reuters"
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Runtime enforcement of the NewsClaim quarantine shape — the TYPE promises it, but card data may
 *  cross a process boundary (batch files, sibling DBs), so the builder re-checks. Invalid → dropped. */
function sanitizeClaims(raw: NewsClaim[], dropped: string[]): NewsClaim[] {
  const ok: NewsClaim[] = [];
  for (const c of raw ?? []) {
    if (!c || typeof c.claim !== "string" || !c.claim.trim()
      || typeof c.source !== "string" || !c.source.trim()
      || typeof c.date !== "string" || !DATE_RE.test(c.date)) {
      dropped.push(`news:invalid-shape:${c && typeof c.date === "string" ? c.date : "?"}`);
      continue;
    }
    ok.push({
      date: c.date,
      source: c.source.trim(),
      tickers: (c.tickers ?? []).map((t) => String(t).toUpperCase()),
      claim: c.claim.trim(),
      ...(c.number !== undefined ? { number: c.number } : {}),
    });
  }
  // Newest first — staleness must be visible, and truncation drops from the OLD end.
  ok.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return ok.slice(0, NEWS_MAX);
}

export function buildCard(inputs: CardInputs, maxTokens: number): BuiltCard {
  const dropped: string[] = [];
  const news = sanitizeClaims(inputs.news, dropped);

  // Fundamentals: cap the field count up front (insertion order = adapter's priority order).
  let fundamentals: FundamentalsSnapshot | null = null;
  if (inputs.fundamentals) {
    const entries = Object.entries(inputs.fundamentals.fields).slice(0, FUNDAMENTALS_MAX);
    fundamentals = { asOf: inputs.fundamentals.asOf, fields: Object.fromEntries(entries) };
  }

  const make = (n: NewsClaim[], f: FundamentalsSnapshot | null): ContextCard => ({
    schema: "wld-card-v1",
    ticker: inputs.entry.symbol,
    asOf: inputs.asOf,
    leiStage: inputs.leiStage,
    flags: {
      momentumRank: inputs.entry.momentumRank,
      insiderCluster: inputs.entry.insiderCluster,
      anchorManagers: inputs.entry.anchorManagers,
    },
    pricePath: inputs.pricePath,
    fundamentals: f,
    news: n,
  });

  let card = make(news, fundamentals);
  const over = () => estimateTokens(card) > maxTokens;

  // Priority 1 — news claims beyond the preferred minimum, oldest (last) first.
  while (over() && card.news.length > NEWS_PREFERRED_MIN) {
    const c = card.news[card.news.length - 1];
    dropped.push(`news:${c.date}:${c.source}`);
    card = make(card.news.slice(0, -1), card.fundamentals);
  }
  // Priority 2 — fundamentals fields beyond the core, last (lowest-priority) first.
  while (over() && card.fundamentals && Object.keys(card.fundamentals.fields).length > FUNDAMENTALS_CORE) {
    const keys = Object.keys(card.fundamentals.fields);
    const k = keys[keys.length - 1];
    dropped.push(`fundamentals:${k}`);
    const fields = { ...card.fundamentals.fields };
    delete fields[k];
    card = make(card.news, { asOf: card.fundamentals.asOf, fields });
  }
  // Priority 3 — remaining claims, oldest first, down to zero if it comes to that.
  while (over() && card.news.length > 0) {
    const c = card.news[card.news.length - 1];
    dropped.push(`news:${c.date}:${c.source}`);
    card = make(card.news.slice(0, -1), card.fundamentals);
  }
  // Priority 4 — the whole fundamentals block.
  if (over() && card.fundamentals) {
    dropped.push("fundamentals:*");
    card = make(card.news, null);
  }
  if (over()) {
    throw new Error(
      `wld card for ${inputs.entry.symbol}: irreducible core is ${estimateTokens(card)} tokens > budget ${maxTokens} — fix contextCardMaxTokens`,
    );
  }
  return { card, tokens: estimateTokens(card), dropped };
}

/** The output-schema instruction sent alongside the cards (forwarded verbatim by the real PickPort
 *  adapter into the structured-output request). Kept here so tests, fixtures, and the Phase-3
 *  adapter all reference ONE schema string. */
export const PICK_SCHEMA_INSTRUCTION =
  `Return ONLY a JSON array. One object per recommended ticker, best first: ` +
  `{"ticker": <from the provided cards only>, "rank": <int, 1 = best>, ` +
  `"conviction_bucket": "low"|"medium"|"high", "thesis": <max 3 sentences>, ` +
  `"invalidation_level": <price > 0 that voids the thesis>, ` +
  `"holding_period": "weeks"|"months"|"quarters", ` +
  `"what_would_change_my_mind": <one concrete disconfirming observation>}`;
