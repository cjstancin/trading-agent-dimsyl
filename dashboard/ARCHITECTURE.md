# Bull — Architecture & Code Guide (Trading Console)

> Read this first if you're a developer (or Claude Code) picking up Bull's dashboard. It explains the goal, the data contract, how the console code works, the guardrails, and how to wire it to the actual paper-trading agent.

---

## 1. What Bull is (goals)

Bull is CJ's **paper-trading console** — the monitor for an aggressive, automated **Alpaca paper** trading agent. It is the loud, "what is the bot doing and is it within its risk limits" view. All trading lives here; the advisor side lives in `Go-Hub/` and the two are decoupled.

Design goals:

1. **Make the bot legible.** Health/uptime, every position, every order and fill, a per-trade journal with grades + lessons, and live risk meters (daily-loss halt, monthly kill-switch, drawdown, exposure).
2. **Paper-first, safety-first.** The bot trades Alpaca **paper** only. The **LIVE** profile is LOCKED behind CJ's written opt-in. The dashboard's "control panel" is a **UI preview only** — it never sends orders from the browser.
3. **Static and cheap**, exactly like Go: one fetched JSON file, no framework, no secrets in the page.
4. **Theme: "Royal Chisel"** — alabaster marble background, `clip-path` 45°-cornered cards with a constant slow gold-gradient rim (`goldflow`, no white gleam), Cinzel (display) + Fraunces (numbers) + EB Garamond (body), emerald up / ruby down, faceted gemstone status dot. Keep it.

---

## 2. File layout

```
Trading-Agent/
  CLAUDE.md             # operating instructions for the Bull agent (execution side)
  memory/               # the bot's memory (profile, caps, holdings, journal seeds, ...)
  routines/             # the bot's run routines (morning brief, scan, execute, journal, review)
  scripts/              # alpaca-rest helpers (read account/positions/quotes; place paper orders)
  Signals/              # signal queue / logs shared with the engine
  dashboard/
    index.html          # the entire console — HTML + CSS + vanilla JS (fetch-only)
    data/status.json    # the ONLY data the page renders. The agent overwrites this.
    ARCHITECTURE.md     # this file
    README.md           # short schema/deploy notes
```

**Mental model:** the **agent** (running on a Claude Code routine with Alpaca keys in env) trades paper and writes `dashboard/data/status.json`; `index.html` just renders it.

---

## 3. Data architecture

Identical rules to Go: `index.html` is a static shell that `fetch()`es `data/status.json` on load, every 5 minutes, and on Refresh. **No embedded sample data.** Preview by **serving** (`python -m http.server` in `dashboard/`, or Netlify) — `file://` blocks the fetch. The price charts on ticker-detail pages pull live daily history from **Stooq** (no key, free) with a `spark` fallback; everything else comes from the JSON.

> **History note:** Bull's pages were empty before the June 2026 rebuild because `data/status.json` had been saved truncated (286 bytes, invalid JSON) and the fetch silently failed. If the console ever goes blank, **validate the JSON first.**

---

## 4. `status.json` schema (the data contract)

| Key | Type | Used by | Notes |
|-----|------|---------|-------|
| `updated`, `isSample` | string, bool | topbar | sample chip when true |
| `profile` | string | pill | e.g. `"Aggressive · Paper"` |
| `regime` | string | pill | |
| `equity`, `cash`, `buyingPower` | number | Overview KPIs | |
| `dayPnlPct`, `dayPnlUsd`, `monthPnlPct`, `vsSpyPct` | number | KPIs, Risk | |
| `stats` | `{winRate, trades, wins, losses, avgWin, avgLoss, profitFactor, sharpe}` | Overview | |
| `bot` | `{status, uptime, version, lastRun, nextRun, heartbeat[]}` | Overview health card | `status` ∈ Running/Paused/Stopped; `heartbeat` is an array of 0-1 bar heights |
| `equityCurve[]` | number[] | Overview chart | raw equity values |
| `caps` | `{riskPerTrade, maxPosition, sectorCap, trailingStop, dailyHalt, monthlyKill}` | Risk, Control panel | the hard guardrails (percent) |
| `positions[]` | `{t, name, lev?, qty, price, avg, mktVal, unrealPct, dayPct, stop, spark?}` | Positions, Overview | `lev` e.g. "3x"/"2x" shows a tag |
| `openOrders[]` | `{time, t, side, type, qty, limit, status}` | Blotter | working orders |
| `fills[]` | `{time, t, side, qty, price, value}` | Blotter, Overview | executed orders |
| `journal[]` | `{t, side, opened, closed, entry, exit, qty, pnlPct, pnlUsd, grade, lesson}` | Journal | one per closed trade; `grade` A-F |
| `risk` | `{drawdown, maxDD, peakEquity, grossExposure, largestPos, sectorConc}` | Risk | |
| `strategy` | `{name, desc, rules[]}` | Strategy | |
| `signals[]` | `{t, signal, score, action}` | Strategy queue | `action` ∈ Buy/Sell/Watch |
| `movers` | `{gainers[], losers[], active[]}` | Movers | items `{t, price, chg, vol?}` |
| `tickers{}` | map `SYM → {name, sector, last, chgPct, spark[], thesis}` | ticker detail | `thesis` = why it's in the book |

The renderer is defensive (`||` fallbacks); missing keys degrade gracefully.

---

## 5. JS architecture (`index.html` `<script>`)

**Helpers** — `up/cls/pc/usd/usd2` formatting, `esc`, `go(route)`, `tk(t)` (clickable ticker; calls `event.stopPropagation()` so it works inside clickable table rows), `curve(arr,w,h,col)` (inline SVG area+line, accepts numbers or `{v}` objects), `card()/kpi()` builders.

**Live chart** — same Stooq pattern as Go: `loadHistory(sym)` + `renderChart(host, sym, fallback)` with range tabs and a `spark` fallback.

**State** — `DATA` (parsed JSON). No `localStorage` editor on Bull (the bot owns the book).

**Sortable table** — `tableSort(rows, cols, renderRow, initKey)` → re-sortable `<table>`. Used by Positions and Blotter.

**Router** — `TABS` defines the tab bar. `route()` reads `location.hash`, dispatches to a page function, and runs any `deferred` callbacks (used to append sortable tables after `innerHTML`). Special route `#/ticker/SYM` → `renderTicker`. Driven by `hashchange`, no framework.

**Pages:**
- `pgOverview` — KPI row (equity, day/month P&L, vs S&P), equity curve, **bot health** card (status, uptime, version, last/next run, heartbeat bars), win-rate / profit-factor / sharpe cards, the **control panel**, open positions table, recent fills.
- `pgPositions` — sortable positions + an **exposure bar chart** (% of equity per name) with gross/largest/sector readouts.
- `pgBlotter` — open orders + a sortable fills blotter.
- `pgJournal` — one card per closed trade: ticker, side, dates, grade, P&L, and the **lesson** text. This is the bot's learning record.
- `pgRisk` — `meter()` renders the **daily-loss halt** and **monthly kill-switch** as fill bars vs their caps (green→amber→ruby as they approach the limit), plus drawdown, exposure, and the full guardrail list.
- `pgStrategy` — strategy name/description, the signal **rules**, and today's **signal queue**.
- `pgMovers` — gainers / losers / most active.

**Control panel (important):** `ctrlMsg()` is the only handler — the Run / Pause / Kill buttons and the risk slider are **a console preview**. They display a message and do nothing else. **Do not** wire them to place real orders from the browser. Execution belongs to the agent's Claude Code routine. If you ever add real control, it must go through a server-side function with auth, never client-side, and must respect the LIVE lock.

**Ticker detail** — `renderTicker(t)` shows the live chart, your position (if held), the bot's `thesis`, and the trade history on that name.

**Site switcher + refresh** — `toggleSwitch()` (brand dropdown Bull ⇄ Go), `pull()` (fetch JSON), `#reload` manual Refresh, `chrome()` (topbar state + timestamp), `setInterval` 5-min auto-pull, `boot()`.

---

## 6. The guardrails (active aggressive-paper profile)

From `caps`: risk per trade **10%** of equity, max single position **40%**, max sector **80%**, trailing stop **~18%**, **daily loss halt −10%**, **monthly kill −30%**. Position sizing the agent uses: `shares = (riskPerTrade% × equity) ÷ (entry − stop)`, capped at `maxPosition%`. The **LIVE** profile is a separate, conservative, **LOCKED** config requiring CJ's written opt-in — never flip it programmatically.

---

## 7. How to wire it to the real bot

1. Create the agent's **Claude Code routine** (claude.ai/code/routines): the `Trading-Agent/` repo + a cloud environment with `ALPACA_API_KEY` / `ALPACA_API_SECRET` (paper) in env vars, network access to Alpaca/Finnhub/FRED, and "allow unrestricted branch pushes."
2. The routine (per `Trading-Agent/CLAUDE.md` + `routines/`) reads account/positions/quotes from the **Alpaca paper REST API** (`https://paper-api.alpaca.markets`, headers `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`; market data at `https://data.alpaca.markets`), applies the strategy within `caps`, places **paper** orders, journals each closed trade, and **overwrites `dashboard/data/status.json`** in this exact schema (`isSample:false`).
3. The optional `go-data-refresh` scheduled task will also refresh Bull **if** the Alpaca env vars are present; otherwise it skips Bull.

**Security:** keys only in env / the routine's cloud environment — never in chat, files, or the repo. (CJ once pasted a live key → it was rotated.)

---

## 8. Deploy

Bull **is** deployed: `dashboard/index.html` serves at **trading.cjstancin.com** via Netlify, auto-building from GitHub **github.com/cjstancin/trading-agent-dimsyl** (publish dir = `dashboard`). To ship changes: from `Trading-Agent/`, `git add . && git commit -m "..." && git push`. Preview locally with a served URL, never `file://`.
