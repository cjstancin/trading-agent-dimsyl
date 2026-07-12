# Phase 0 — LLM Edge Test

## What Phase 0 answers

One make-or-break question: **does Claude Sonnet 4.6's stock-picking beat a dumb mechanical
momentum baseline on data it has never seen — or is its apparent skill just memorization?**

Every LLM backtest run inside the model's training window is contaminated. The model may not be
"predicting" anything — it can simply remember what happened. Glasserman & Lin call this the
**profit mirage**: LLM trading backtests look great in-window, then the edge decays sharply
(roughly half or more in their tests) once you cross the training cutoff. If we don't test past
the cutoff, we learn nothing.

Cutoffs for Sonnet 4.6: **training data through Jan 2026, reliable knowledge through ~Aug 2025.**
So the only clean out-of-sample (OOS) window starts **Feb 2026**. Everything before that is
suspect; everything in 2024–mid-2025 is almost certainly memorized.

If the LLM can't out-rank a 63-day momentum sort on clean data, Bull should not be paying an LLM
to pick stocks.

## Design

- **Two windows.**
  - `IN` (memorization window): decision dates 2024-01-02 → 2025-06-30. Deep inside training data.
  - `OOS` (clean window): decision dates 2026-02-02 → the last date with 21 more trading days in
    the calendar. Past both cutoffs.
- **Decision cadence:** every 5th trading day on the SPY calendar (weekly-ish).
- **Horizon:** forward return over the next **21 trading days** (~1 month), positional on the SPY
  calendar. A date only counts if t+21 exists.
- **Universe:** 18 large caps across 7 sectors (AAPL MSFT NVDA GOOGL META AMZN HD JPM V XOM CVX
  UNH JNJ PG KO WMT CAT BA). Benchmark: SPY.
- **Point-in-time, price-derived features only** — computed strictly from rows ≤ t, no lookahead:
  `r21, r63, r126, r252` (trailing returns), `vs200dma` (close vs 200-session SMA), `vs20dhi`
  (close vs 20-session closing high), `atrPct` (22-period ATR / close), plus SPY context
  (close, vs200dma, r21, r63, regime ON/OFF). No news, no fundamentals, no web. The model gets a
  stats table and nothing else.
- **Output:** the model ranks **all 18 tickers** strongest-first as strict JSON, per decision date.
- **Four comparison arms**, equal-weight mean forward return per date:
  - `LLM5` — top 5 of the model's ranking
  - `MOM5` — top 5 by trailing `r63` (the mechanical baseline the LLM must beat)
  - `UNIV` — all 18 equal-weight
  - `SPY` — the index
  (Also tracked: `LLMbot5`, the model's bottom 5 — a good picker's bottom should underperform.)
- **Rank IC:** Spearman correlation between the model's full 18-ticker ranking and realized
  forward returns, per date. This scores ranking skill across the whole list, not just the top 5.
- **Memorization gap:** (IN-window edge) − (OOS-window edge), with a bootstrap confidence
  interval. This is the profit-mirage measurement — how much of the in-window performance
  evaporates on clean data.

## How to run

```
# from the Trading-Agent repo root; refresh data first if stale
python backtest/backtest.py --refresh

cd backtest/phase0 && python gen_prompts.py
cd ../../agent && npx tsx src/phase0-picker.ts     # rides Claude Max login; strips ANTHROPIC_API_KEY
cd ../backtest/phase0 && python evaluate.py
```

Artifacts land in `phase0/out/`: `prompts.jsonl` (one prompt per decision date),
`picks.jsonl` (one ranking per date, with cost + error fields), then evaluate.py prints the
per-arm stats, rank IC, and the IN-vs-OOS gap.

**Do not refresh data between picking and evaluating** — evaluate.py rescores forward returns
from the CSVs, and a refresh in between means newer back-adjusted prices than the LLM was shown
(evaluate.py detects this and prints a DATA DRIFT warning). The picker is resumable: each pick
line carries a hash of the exact prompt it answered, so a regenerated prompts.jsonl automatically
re-runs affected dates instead of silently reusing stale picks. To extend the OOS window later:
refresh → regenerate prompts → picker re-runs only the new/changed dates → evaluate.

## Decision rule

evaluate.py issues a four-way verdict, gated on **OOS mean(LLM5 − MOM5)** with a 90%
circular-block-bootstrap CI (blocks of 5 consecutive dates, respecting the overlapping horizons):

1. **INSUFFICIENT DATA** — fewer than 5 usable OOS dates. No verdict; extend the window and rerun.
2. **NO EDGE** — the CI excludes positive values. The LLM is demoted to screener/veto duty —
   filtering or sanity-checking candidates — while the deterministic momentum engine carries
   the actual picking.
3. **WEAK/INCONCLUSIVE** — the CI straddles 0 (either sign of point estimate). Stay in
   forward-paper validation; do not expand LLM authority.
4. **POSITIVE** — the CI excludes 0 from below. The LLM keeps the picker seat; the deterministic
   engine stays as risk/exit management around it; forward paper continues to confirm.

Separately, the report states whether the **memorization mirage is confirmed** — whether the
IN-window edge exceeds OOS with the gap's block-bootstrap CI excluding 0. A confirmed mirage
means any in-sample LLM backtest must be treated as fake regardless of the verdict branch.
(Rank IC and the top-bottom spread are reported as supporting evidence, not verdict gates.)

Either losing outcome is fine. The point is to stop guessing about whether the expensive
component earns its seat.

## Caveats

- **Thin OOS window.** ~5 months, ~19 weekly decision dates. Enough to detect a collapse, not
  enough for tight significance. Treat OOS stats as directional.
- **Price-only context.** The live Bull picker also sees news and web search. Phase 0 isolates
  the *pure ranking-skill channel* — a pass/fail here doesn't measure the news channel.
- **Survivorship-tilted universe.** 18 hand-picked mega caps that all survived to 2026. Absolute
  returns are inflated; relative comparisons between arms are still fair since all arms share
  the universe.
- **Overlapping horizons.** Weekly decisions with a 21-day horizon overlap, so per-date returns
  are autocorrelated. A naive t-test or IID bootstrap would overstate significance ~2× — the
  verdict and gap CIs therefore use a circular **block** bootstrap (blocks of 5 consecutive
  dates), and the non-overlapping rows in the report are a further robustness check.
- **Back-adjusted price levels.** The Close shown for IN-window dates is today's
  dividend/split-adjusted level, not the price the model saw in training — memorization operates
  through dates and return patterns, so the measured mirage is, if anything, conservative.
- **Forward paper trading remains the definitive test.** A clean OOS backtest earns the LLM a
  live paper seat, nothing more. Real verdicts come from Bill running it forward.
