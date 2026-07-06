# Bill the Bull — backtest harness

Validates the **deterministic risk engine** (`agent/src/risk-engine.ts`), not the LLM's picks.
The LLM signal can't be honestly backtested (the "profit mirage" — it memorizes past prices), so
this drives the live rules with a transparent mechanical trend+momentum+breakout entry as a stand-in,
and measures whether the *plumbing* behaves: sizing, the 15% portfolio-heat cap (raised from 10% — CJ, 2026-07-06), ATR(22)×3 Chandelier
trailing stops, the 200-day-MA regime filter, and trading costs.

```bash
pip install -r requirements.txt
python backtest.py            # uses cached data in ./data (auto-fetches if missing)
python backtest.py --refresh  # force re-download
```

Outputs → `out/RESULTS.md` (summary table) and `out/equity_curve.csv`.

See the docstring at the top of `backtest.py` for the full methodology, what it proves, and the
survivorship/look-ahead caveats. Latest run (made under the old 10% ceiling): **half SPY's drawdown
(−16.8% vs −33.7%), better Sharpe (0.74 vs 0.66) and Calmar (0.72 vs 0.46), heat cap never breached
(peak 8.7% vs the then-10% ceiling)** — the safety layer works; the LLM only has to beat a trend
baseline at name selection. Re-run for numbers under the 15% ceiling.

---

## Backtest v2 — real-proposal replay (strategy evaluation)

The layer above only proves the plumbing. **Backtest v2** evaluates the ACTUAL strategy: it replays
every real BUY proposal Bill logged in `memory/ledger.jsonl` (entry `est_price`, per-position
`trail_percent`, setup tag, confidence, timestamp) against historical daily bars from the **same
keyless Yahoo chart feed** `agent/src/stats.ts`/`regime.ts` already use (no new/paid data), under his
**real deterministic exit rules**: the synthetic trailing stop (peak-seeded at entry, ratcheted on
daily highs — mirrors `synthetic-stops.ts` + `reconcile.ts` R-math), plus optional hard-target /
time-stop sensitivity knobs (live Bill has neither — his profit-trim/revalidate exits are LLM-sized
and deliberately NOT replayed).

It lives in TypeScript next to the ledger (`agent/src/replay.ts` pure engine +
`agent/src/backtest-replay.ts` CLI) because the ledger and the live attribution are TS; the
walk-forward attribution below uses the **identical `attribution()` aggregation the live scan's
outcome-feedback loop consumes**, sliced by setup tag, walk-forward SPY regime at proposal time,
ET time-of-day, and confidence bucket — plus per-tag expectancy/win-rate/profit factor, equity
curve, max drawdown, and vs-SPY.

```bash
cd ../agent
npm run backtest:replay                                   # memory/ledger.jsonl, 5 bps slip, $1000
npm run backtest:replay -- --ledger path.jsonl --capital 1000 --slip-bps 5
npm run backtest:replay -- --target 15 --max-hold 20      # sensitivity: hard target / time-stop
npm run backtest:replay -- --refresh                      # ignore the price cache (data/replay-cache/)
npm run test:replay                                       # unit tests (pure, offline)
```

Outputs → `out/REPLAY-RESULTS.md` (labelled report), `out/replay_trades.csv`,
`out/replay_equity.csv`, `out/replay_attribution.json`. It never writes `RESULTS.md` — the two
layers stay separate: `RESULTS.md` = mechanical stand-in proving the risk engine;
`REPLAY-RESULTS.md` = Bill's real proposals under his real stops.

**Limits (also printed in the report):** a replay of past proposals is **not a forward guarantee**;
only symbols Bill actually proposed (and that still quote) are replayed (selection/survivorship
bias); exits are simulated on daily bars (a wick fires the stop where the live 5-min poll might
not, and a same-day new-peak→fall stop-out can't be seen); LLM-driven exits (profit trim,
revalidation, reallocation) are not replayed; and the LLM-memorization "profit mirage" still
applies to any window inside training data — forward paper trading (Phase 0) remains the only
clean validation. Offline analysis: it reads the ledger + historical prices and places nothing.
