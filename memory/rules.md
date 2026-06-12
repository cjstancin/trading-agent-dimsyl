---
type: "memory"
file: "rules"
date: "2026-06-12"
summary: "Two profiles. AGGRESSIVE PAPER is active. LIVE is LOCKED and requires CJ's written opt-in. Read first on every run."
---

# Trading Rules — Bull

> The agent READS this first every run. The ACTIVE profile governs all paper trading. The LIVE profile is LOCKED — do not use it to place real-money trades without CJ's explicit written opt-in.

---

## ✅ ACTIVE PROFILE — AGGRESSIVE PAPER (set by CJ 2026-06-12)
Sandbox for high-risk/high-reward learning. Fake money. Run it hot, but keep the floor below.

**Sizing**
- Risk **10% of equity per trade**: `shares = (0.10 × equity) ÷ (entry − stop)`, then cap at max position %.
- **Max position: 40%** of equity.
- **Max sector: 80%.**
- **Max open positions: 6. Max new per week: 6.**
- **Cash buffer: ~10%** (never fully deploy).
- **No margin.**

**Stops & exits (always on)**
- **Stop on EVERY entry** — default **~18% trailing** (wide, for leveraged/crypto/high-beta).
- **Cut losers at ~−12%** from entry (midday rule) unless strategy explicitly says hold.
- Tighten trailing stops on big winners to lock gains.

**Circuit breakers**
- **Daily-loss halt: −10%** of equity → place NO new trades the rest of the day.
- **Monthly kill-switch: −30% MTD** → write "STAND DOWN — no new trades" and skip cycles until CJ resumes.

**Universe (paper)**
- US equities, ETFs, **leveraged ETFs** (e.g. TQQQ, SOXL), **crypto** (BTC/ETH + liquid majors), high-beta momentum & small-caps. Speculative tier embraced.
- **Quality floor:** price > $2, real liquidity/volume, no obvious pump-and-dump. Risky but real — not lottery tickets.
- Note: crypto trades 24/7; equity routines run weekdays. Crypto positions are still managed each run.

---

## 🔒 LOCKED PROFILE — LIVE (DO NOT USE without CJ's written opt-in)
If/when CJ opts into real money, these REPLACE the aggressive settings. Live money resets to tight, conservative caps. The aggressive paper settings must NEVER be used with a live key.

- Paper→live requires: several clean paper weeks + guardrails verified + CJ says so **in writing**.
- Risk **2% per trade**. **Max position 10%. Max sector 50%. Max 8 open. Max 3 new/week. Cash buffer 20%. No margin.**
- Stop on every entry (~10% trailing). Cut losers ~−7%. **Daily-loss halt −3%. Monthly kill −10% MTD.**
- Universe: US equities + ETFs only. **No leveraged ETFs, no crypto, no options, no penny/meme.**
- Start with **small capital** CJ can afford to lose; scale only after it earns it.

---

## Both profiles — invariant rules
- **Stop on every trade.** No naked positions, ever.
- **Never widen a limit autonomously.** Propose changes in the weekly review for CJ's approval.
- **Log every trade with a one-line thesis.** Honest journaling.
- **Keys in env vars only**, spelled exactly: `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `DISCORD_WEBHOOK_URL`. Paper endpoint only while live is locked.
- **Read memory first, write/commit memory last.**
- Educational, not financial advice. CJ owns every trade.
