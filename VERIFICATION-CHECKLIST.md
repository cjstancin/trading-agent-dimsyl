---
type: "checklist"
file: "VERIFICATION-CHECKLIST"
date: "2026-06-12"
summary: "P2 verification. Tick after dry runs."
---

# Project 2 — Verification Checklist

## Build present (done — confirm files)
- [x] `Trading-Agent/` folder with CLAUDE.md, memory/, routines/, scripts/, dashboard/.
- [x] rules.md holds BOTH profiles: AGGRESSIVE PAPER (active) + LIVE (locked).
- [x] strategy.md starter draft present (awaiting approval).
- [x] 5 routine prompts + Alpaca REST reference + dashboard scaffold.

## Functional (after wiring + dry runs)
- [ ] Strategy approved by CJ.
- [ ] Alpaca **paper** account balance/positions read correctly and match the dashboard.
- [ ] A paper order places, fills, and is logged with a thesis + ~18% trailing stop.
- [ ] Sizing caps a position at the **40%** max (10%-risk math respected).
- [ ] **−10% daily-loss halt** blocks new trades when tripped.
- [ ] Midday cuts a simulated **−12%** loser and tightens a winner's stop.
- [ ] **−30% monthly kill-switch** writes STAND DOWN on a simulated drawdown.
- [ ] Close run reconciles, marks P&L vs S&P, journals, and sends the Discord summary.
- [ ] Weekly review scorecards vs S&P and self-grades.
- [ ] Reads `../Finance-Research/Signals/approved-cycle.md` and sizes/executes those ideas.
- [ ] Universe rules honored (leveraged ETFs + crypto allowed; sub-$2/junk rejected).
- [ ] LIVE profile remains untouched; `ALPACA_BASE_URL` is the paper endpoint.

## Remote / dashboard (when graduating)
- [ ] Memory files commit back to main each remote run.
- [ ] `dashboard/data/status.json` updates and Netlify redeploys.
- [ ] `trading.cjstancin.com` resolves with SSL.
- [ ] Discord notifications arrive.

## Go-live gate (future, explicit)
- [ ] Several clean paper weeks reviewed.
- [ ] CJ opts in **in writing**, switches to the LOCKED conservative LIVE profile, funds small capital. Until then: paper only.
