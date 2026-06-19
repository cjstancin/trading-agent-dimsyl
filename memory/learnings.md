---
type: "memory"
file: "learnings"
date: "2026-06-19"
summary: "Dated lessons from each run. Honest accountability — not cheerleading."
---

# Learnings — Bull (paper)

---

## 2026-06-19

**Cloud execution requires egress allowlist** — Alpaca (`paper-api.alpaca.markets`) and Finnhub (`finnhub.io`) are both blocked by the cloud environment's network egress policy. This entirely prevents autonomous order execution from cloud runs. A 24/7 trading agent that can't reach its broker is broken. Fix: CJ must whitelist these hosts in execution environment settings. Priority: HIGH. Until resolved, all trades must be placed manually via Alpaca's web dashboard.

**Holiday awareness** — June 19 is Juneteenth (US federal holiday); NYSE/NASDAQ closed. Any GTC limit orders placed today would queue for Monday June 22. Running on holidays is fine for research and queue-building — just be aware nothing executes until next session.

**Pre-earnings sizing risk** — MU earnings are June 24 (5 days away). Entering now is a catalyst bet. Earnings can gap ±10–20% at the open, and a stop at 20% trailing might execute at a much worse price if MU gaps down hard. CJ should decide: (a) take the pre-earnings entry for potential momentum into the report, or (b) wait for the post-earnings base and miss some upside but reduce gap risk. For the aggressive paper account, option (a) is appropriate — but CJ should know the gap risk.

**NEUTRAL regime = be choosier** — VIX at 16.4 sits right at the RISK-ON/NEUTRAL boundary. Combined with a hawkish Fed (Warsh removed rate cuts, potential hike), trimming new position sizes ~25% and capping at 3 names is disciplined. Doing more entries in NEUTRAL just for activity would dilute the quality bar.

**Differentiate from real book** — CJ's Fidelity book is ~76% AMD+MSFT. Paper account adding AMD or NVDA directly would create unnecessary overlap and reduce the informational value of paper trading. MU, INTC, and ANET are all names CJ gets essentially zero exposure to in real life, so paper P&L teaches something new.
