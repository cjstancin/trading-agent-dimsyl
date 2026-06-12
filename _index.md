---
type: "index"
date: "2026-06-12"
topics: [Trading Bot, Claude Cowork Finance, Alpaca, Scheduled Tasks (Finance), Netlify Dashboard]
summary: "Live workspace for Project 2 — Bull, the aggressive PAPER trading agent that consumes Project 1's approved signals."
---

# Trading-Agent — Project 2 "Bull" (live workspace)

Built 2026-06-12 from the P2 Trader Pack + CJ's intake. **Paper only.** Consumes `../Finance-Research/Signals/approved-cycle.md`.

## Start here
- **Finish setup (your hands):** [[SETUP-GUIDE]] → then [[VERIFICATION-CHECKLIST]].
- **Approve the strategy:** [[memory/strategy]] (draft).
- **Identity + rules (auto-loaded):** [[CLAUDE]].

## Profile (active)
AGGRESSIVE PAPER: 10% risk/trade · 40% max position · 80% sector · 6 open / 6 new per week · ~18% trailing stops · −12% cut · **−10% daily halt** · **−30% monthly kill** · leveraged ETFs + crypto in play. LIVE profile is **LOCKED** (conservative, written opt-in only). See [[memory/rules]].

## Memory (the agent's brain)
- [[memory/rules]] · [[memory/strategy]] · [[memory/portfolio]] (paper) · [[memory/trade-log]] · [[memory/research-log]] · [[memory/learnings]] · [[memory/weekly-review]]

## Routines (paste into Claude Desktop, or ask me to schedule)
- [[routines/01-pre-market]] (07:30) · [[routines/02-market-open]] (09:35) · [[routines/03-midday]] (12:00) · [[routines/04-close]] (15:45) · [[routines/05-weekly-review]] (Fri 16:15)

## Execution + display
- [[scripts/alpaca-rest]] — Alpaca PAPER REST reference (read + order).
- `dashboard/` — static Netlify dashboard ([[dashboard/README]]); publishes `dashboard/data/status.json`.

## Related
- [[_Finance Projects - Start Here]] · [[Finance-Research/_index|Project 1 workspace]] · [[Free APIs & Keys]] · [[P2 Trader Pack - 11 Build Runbook]]
