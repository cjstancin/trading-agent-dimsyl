---
type: "memory"
file: "strategy"
date: "2026-07-06"
status: "ACTIVE. Rewritten 2026-07-06 to match the deterministic risk engine."
summary: "Bill's playbook: entry setups, regime overlay, exits. All sizing/caps are code-enforced — zero cap numbers in this file."
---

# Strategy — Bill (aggressive-quality paper) · ACTIVE

> Sizing, per-name/sector/heat caps, halts, and the price floor are **enforced by code** (`agent/src/guardrails.ts` + `agent/src/risk-engine.ts`) and summarized in CLAUDE.md's caps table. This file holds no cap numbers on purpose — you propose the idea and the stop; the engine decides how much.

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
