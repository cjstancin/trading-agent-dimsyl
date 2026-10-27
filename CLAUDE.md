# Bull v3 — autonomous intraday paper trader

Ground-up rebuild locked 2026-10-27. v2 is preserved at tag `v2-final`. Decisions canon:
`AIBrain/01_Knowledge/Projects/AI Manager - AgentSims/Bull/2026-10-27 Bull v3 rebuild — intake decisions.md`.
Read `AIBrain/02_LLMKnowledge/lessons/bull.md` before touching anything.

## Rails (never weaken)
- **Paper only.** `config.toml [account] paper = true` and `TradingClient(paper=True)` are hard-wired; `assert_paper` refuses any live base URL. Live money is CJ's explicit decision, never a code change made on his behalf.
- **Every entry is a bracket order**: stop and target are held by Alpaca from the moment of fill. The engine closes any position it finds without a live stop.
- **Alpaca is the only truth.** No ledger of our own. Day state is rebuilt from today's orders every tick, so restarts lose nothing.
- **Flat every day** at `flatten_at` (15:50 ET). Day trading only: no overnight positions.
- Keys live in `/home/cj/bull/.env` (`ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `NTFY_*`), written by CJ. Never print or commit them.
- Phone pings (ntfy) only for real trouble, deduped. Upkeep for CJ should be zero.

## Layout
| Path | What |
|---|---|
| `bull/strategies.py` | VWAP pullback, opening-range breakout, gap-and-go. Pure, no lookahead (tested). |
| `bull/backtest.py` · `bull/bakeoff.py` | Fee- and slippage-aware replay on SIP 1-min history; writes `runtime/bakeoff.json` |
| `bull/engine.py` | Live loop, one tick a minute; picks the watchlist at 09:31, trades bake-off survivors |
| `bull/broker.py` | Alpaca SDK (`alpaca-py`): brackets, day state, protection, flatten |
| `bull/site.py` · `web/index.html` | One-page site on 127.0.0.1:4326 → https://bull.dimsylaisolutions.com (Caddy basic auth) |
| `bull/features.py` | RVOL, ATR, gap and entry features shared by live, journal and backtests |
| `bull/journal.py` | `runtime/journal.csv`: one row per real or shadow trade, written at 15:52 ET (MAE/MFE in R, loss reason) |
| `bull/experiment.py` | `python -m bull experiment --days N`: multi-year control-vs-filter replay → `runtime/experiment.json` |
| `config.toml` | Every knob: risk, costs, watchlist, variants, bake-off pass rules, pre-registered `[[shadow]]` filters |
| `deploy/` | systemd units: `bull3-engine`, `bull3-site`, `bull3-bakeoff.timer` (Saturdays) |

## Commands
```
python -m bull check      # verify keys + paper account
python -m bull bakeoff    # rank all variants (default 60 days)
python -m bull engine     # live loop (systemd runs this)
python -m bull site       # the page
python -m unittest discover -s tests
```

## Which strategies trade
`[strategies] enabled = "bakeoff"`: up to 3 candidates (methods plus pre-registered filters) that passed the latest **4-year** bake-off: ≥100 trades, net > 0 after costs, t-stat on mean R ≥ 2, and profitable in more than half the years with 10+ trades. If none pass, the strongest by t-stat trades on paper **probation**, and the site says so. The engine re-reads this each morning; the bake-off re-runs every Saturday. (Changed 2026-10-27: a 60-day pass turned out breakeven over 4 years.)

## Learning loop
- `[[shadow]]` variants are pre-registered filters. The engine records what each would have done (never trades them) and the journal resolves them at the close, so their forward record builds alongside the real one.
- Change live rules only when a filter beats the control in BOTH the multi-year experiment and the forward shadow record. One change at a time, never because of a single loss.
- `events.jsonl` is pruned to 14 days. The journal is the permanent record (~300 bytes per trade).

## Deploy
PC: commit → push → PR → merge. VPS (over the tailnet, `ssh root@100.100.66.87`):
`sudo -u cj -H bash -lc 'cd /home/cj/bull && git pull --ff-only && .venv/bin/pip install -q -r requirements.txt'` then
`systemctl restart bull3-engine bull3-site`. Logs: `/home/cj/bull/runtime/logs/`, plus `journalctl -u bull3-engine`.
