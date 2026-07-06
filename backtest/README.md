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
