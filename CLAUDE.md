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
| `config.toml` | Every knob: risk, costs, watchlist, variants, bake-off pass rules |
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
`[strategies] enabled = "bakeoff"`: up to 3 variants that passed the latest bake-off (≥30 trades, net > 0 after costs, profit factor ≥ 1.2, profitable in both halves). If none pass, paper-trade the best-ranked one on probation, so the site says so. The engine re-reads this each morning; the bake-off re-runs every Saturday.

## Deploy
PC: commit → push → PR → merge. VPS (over the tailnet, `ssh root@100.100.66.87`):
`sudo -u cj -H bash -lc 'cd /home/cj/bull && git pull --ff-only && .venv/bin/pip install -q -r requirements.txt'` then
`systemctl restart bull3-engine bull3-site`. Logs: `/home/cj/bull/runtime/logs/`, plus `journalctl -u bull3-engine`.
