# Bill the Bull — Backtest v2: REAL-PROPOSAL REPLAY (strategy evaluation)

_Generated 2026-07-06T18:09:02.737Z by `agent/src/backtest-replay.ts` (offline analysis — reads the proposal ledger + historical prices; places NOTHING)._

## What this is (vs the plumbing backtest)
`backtest/out/RESULTS.md` (from `backtest.py`) validates the **deterministic risk plumbing** with a
**mechanical** trend stand-in — it says nothing about the LLM's picks. THIS report is the
**strategy-evaluation layer**: it replays **Bill's actual logged proposals** (`memory/ledger.jsonl` —
every real entry with its price, trail, setup tag, confidence and timestamp) against historical daily
bars under his **real deterministic exit rules** (synthetic trailing stop at each proposal's own
trail %, peak-seeded at entry). Attribution below uses the SAME `attribution()` aggregation the
live scan's outcome-feedback loop consumes.

## Result

**No replayable proposals** (0 eligible in the ledger window; skipped: none). Once Bill logs real buy proposals, re-run `npm run backtest:replay`.

## Honest limits — read before believing any number
- **A replay of past proposals is NOT a forward guarantee.** It measures how the ideas Bill already
  had would have resolved under his exit rules — nothing about ideas he'll have next month.
- **Selection/survivorship bias**: only symbols Bill actually proposed (and that still return data
  from the keyless Yahoo feed) are replayed; delisted/renamed names drop out.
- **Look-ahead caveat**: entries use the ledger's recorded `est_price` on the proposal's cycle date
  (clamped to that day's bar when implausible), so no future data leaks into entries; exits test
  daily-bar lows against a stop set from the PRIOR day's peak — a wick the live 5-minute poll missed
  will fire here (conservative), while a same-day new-peak→fall stop-out cannot (optimistic).
- **LLM-driven exits are NOT replayed**: the news-aware profit trim, revalidation sells and
  reallocation swaps are model decisions — the replay holds to the deterministic stop only, so live
  results will differ from replayed results even on identical entries.
- **The LLM memorization mirage still applies** to any window inside the model's training data: the
  model may have 'known' these prices when proposing. Forward paper results (Phase 0) remain the
  only clean validation; treat this as diagnostic attribution, not proof of edge.
- **Costs**: 5 bps per side slippage, zero commission (Alpaca paper).
  No dividends/corporate-action adjustments beyond what the price feed bakes in.

_Educational/research output — paper-trading analysis only, not investment advice._
