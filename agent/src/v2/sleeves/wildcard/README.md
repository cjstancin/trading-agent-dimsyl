# Wildcard sleeve (`wld`) — LLM second-opinion concentrator

Design §6 of the locked Bull v2 design doc (vault: `2026-08-10 Bull v2 — design doc (build
contract).md`). 10% of book (~$500 at inception). The experiment: does letting Claude concentrate
the system's OWN signals into 2–3 names add anything over the mechanical sleeves? Benchmark is the
honest one — an equal-weight basket of what the other three sleeves held (design §8).

## Shape

```
pool.ts        pool = momentum top-25 ∪ live insider clusters (incl. shadow) ∪ Anchor top-5s,
               deduped with merged source flags. NEVER a name the system didn't surface.
card.ts        schema-fixed context card per candidate: ≤2.5k tokens (config), extractive + dated.
               No raw article text, ever. Truncation drops whole units in priority order.
validate.ts    hard all-or-nothing schema check on the model output. One bad item → whole
               response rejected → book KEPT (logged in wld_picks, valid=0).
churn.ts       pure, code-enforced: min 4-week hold absent invalidation · 4-week re-entry
               cooldown · held names checked ONLY vs their own invalidation (never re-litigated;
               they're excluded from the pool sent to the model) · max 1 discretionary change/week.
planner.ts     pick count = equity-indexed schedule derived from config (2 at $500 → 3 capped);
               equal-sized buys × deployScalar (LEI dial: book layer supplies 1.0/0.7/0.55).
stops.ts       ATR(14, Wilder) × 2.5 trailing stops: bot-side peak ratchet (stop only rises) +
               morning re-place of day-TIF broker stop orders. Stop fires → stop_fired handoff.
run.ts         the weekly orchestration; every order via the shared order gateway (owner "wld").
store.ts       private tables (wld_picks, wld_book_log) + position_meta(sleeve='wld') helpers.
fixtures.ts    deterministic offline adapters for all three ports + bar generator.
adapters.ts    real adapters (see honesty table below).
```

Config dials: `agent/config/v2.defaults.json → "wildcard"` (picks.count/countMax, minHoldWeeks,
reentryCooldownWeeks, maxChangesPerWeek, contextCardMaxTokens, atrStop.atrDays/multiple). Loaded
via `loadConfig()`; nothing that exists there is hardcoded here.

## Ports — REAL vs STUBBED (integration honesty)

| Port | Status | Notes |
| --- | --- | --- |
| `PoolPort` fixture | real (offline) | canned 25+2+3 world, dedupe cases included |
| `PoolPort` sibling (`siblingPoolPort`) | best-effort | reads `mom_ranks(symbol, rank)`, `ins_clusters(symbol)`, `anc_clone(symbol, manager)`; missing table/column ⇒ empty source. **Shapes are ASSUMPTIONS** — siblings built concurrently; supervisor verifies at the seam. All `ins_clusters` rows are flagged `live` until a funded/status column is confirmed. |
| `CardPort.pricePath` | real | Alpaca daily bars (free-tier data host) + `latestPrice`; ATR(14) from `stops.computeAtr` |
| `CardPort.fundamentals` | stub → Phase 3 | returns `null`; will ride the EDGAR companyfacts cache |
| `CardPort.newsClaims` | stub → Phase 3 | returns `[]`; claims MUST arrive pre-schematized `{date, source, tickers, claim, number}` from the quarantined converter — the type + card builder enforce the shape, raw text is dropped |
| `PickPort` (`sonnetBatchPickPort`) | stub → Phase 3 | documents the Sonnet-class Batch API call; throws until the SDK + quarantine are wired. run.ts converts the throw into a kept book. |

## The stop_fired → judgment-layer handoff

When a stop fires (broker day-TIF stop filled, or the bot-side monitor sees price ≤ ratchet level),
`stops.emitStopFired(db, symbol, {firedPrice9, ts, source})`:

1. writes a `StopFiredEvent` (schema `wld-stop-fired-v1`) to state key **`wld:stop_fired:<SYMBOL>`**
2. mirrors it onto the `position_meta` row and freezes the position (no stop re-arming, no
   auto-sell, excluded from churn until resolved)

The event carries the position's **ORIGINAL** `invalidationLevel`, `thesis`, and
`whatWouldChangeMyMind` — the anti-sycophancy assets the thesis-check judges the model against.
The judgment layer (Opus-class, 3 judges, design §6) owns the sell/hold verdict, the **−25 %
-from-entry hard floor (its code, not ours)**, and — on a sell — calling `store.logBookEvent(db,
sym, "exit", week, reason)` (starts the re-entry cooldown) plus clearing the state key and the
meta row. On a hold verdict it clears `meta.stopFired` so stops re-arm next morning.

## Rails carried by construction

- Paper-only, settled-cash-gated, $1-floor, 31-day wash blacklist: every order goes through
  `placeOrder` (the only order path); protective stops pass `blacklistExempt`.
- The sleeve never reads Alpaca's buying-power figure (structural grep test in the gateway suite).
- Fresh context every call: `wld_picks` stores pool/cards/response for AUDIT; nothing is ever fed
  back into a prompt.
- Fail direction is always "keep the book": malformed response, port throw, empty pool, missing
  price → no trade, logged.

## Tests

`agent/src/test-v2-wildcard.ts` — offline, `:memory:` DB, fixture ports, mock broker.
Run: `cd agent && npx tsx src/test-v2-wildcard.ts`
