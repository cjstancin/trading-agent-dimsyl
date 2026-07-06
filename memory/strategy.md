---
type: "memory"
file: "strategy"
date: "2026-07-06"
status: "ACTIVE. Rewritten 2026-07-06 to match the deterministic risk engine."
summary: "Bill's playbook: entry setups, regime overlay, exits. All sizing/caps are code-enforced — zero cap numbers in this file."
---

# Strategy — Bill (aggressive-quality paper) · ACTIVE

> Sizing, per-name/sector/heat caps, halts, and the price floor are **enforced by code** (`agent/src/guardrails.ts` + `agent/src/risk-engine.ts`) and summarized in CLAUDE.md's caps table. This file holds no cap numbers on purpose — you propose the idea and the stop; the engine decides how much.
>
> **Position count is NOT fixed** (CJ, 2026-07-06): there is no slot count. Hold as many — or as few — names as the risk rules allow; the binding constraints are per-trade risk, the per-name cap, the sector cap, the portfolio-heat ceiling, and cash/buying power. A swap (cut weakest, fund stronger) is only needed when a new full-size entry no longer fits under those constraints.

## Objective
Beat the S&P 500 with concentrated, high-conviction positions in quality, liquid US large/mid-cap equities and non-leveraged broad/sector ETFs, held 1 week to ~5 years. Quality over quantity; let winners run.

## Entry setups (take a trade when 2+ align)
1. **Breakout:** clears a multi-week/52-week high on above-average volume.
2. **Momentum leader:** relative strength vs SPY inside a leading sector.
3. **Oversold snapback:** quality name down 15%+ with intact fundamentals, turning up off support.
4. **Catalyst:** dated near-term event (earnings, guidance, product) from `Signals/approved-cycle.md` or your own scan.

Prefer analyst-scored ideas in `Signals/approved-cycle.md`; use own scans for setups it missed.

## Regime overlay (200-day MA)
- **Risk-ON** (price ≥ MA200): deploy normally.
- **Risk-OFF** (price < MA200, or major macro stress): high-conviction only, favor cash, fewer/no new entries. The engine's halts gate everything regardless.

## Exits
- **ATR trailing stop** (Chandelier: highest-high − ATR×mult, code-computed) on every position. Never remove a stop; never widen one mid-trade.
- **Thesis break** → exit regardless of P&L.
- **Trim into strength** at first target; let a runner ride on the trailing stop.
- **Time stop:** dead money ~2–3 weeks with no progress → recycle the capital.
- On a thesis-intact dip, re-evaluate; don't panic-sell.

## What NOT to trade
Leveraged/inverse ETFs, crypto, penny/sub-floor names, meme/pump tickers, illiquid names, options, margin. Universe = CLAUDE.md's.

## Change log
- 2026-06-12 — Initial aggressive draft; approved by CJ.
- 2026-07-06 — Rewritten to match the deterministic risk engine: removed crypto + leveraged-ETF sections and every hardcoded cap number (the code owns caps now).
- 2026-07-06 — Removed the fixed max-open-positions slot count (was 10) per CJ: position count is governed only by risk/heat/name/sector/cash. Swaps trigger on "no room under the risk caps", not "book at N/N".
