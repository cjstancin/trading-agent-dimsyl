---
type: "guide"
file: "SETUP-GUIDE"
date: "2026-06-12"
summary: "Finish-setup steps for Bull: project, routines, paper verify, then cloud + Netlify dashboard."
---

# Project 2 — Setup Guide (your hands)

The `Trading-Agent/` scaffold, memory, rules (both profiles), strategy draft, routine prompts, Alpaca REST reference, and dashboard are built. This covers the steps only you can do. Order matters.

## 0. Approve the strategy
Open `memory/strategy.md`, read the starter aggressive playbook, edit anything, and tell me **"strategy approved"** (or change it). The agent treats it as a draft until you sign off.

## 1. Create the project
1. New Claude **Project** named **"Bull — Trading Agent."**
2. **Attach two folders** so it can read both: `Trading-Agent/` (its own brain) and `Finance-Research/` (to read `Signals/approved-cycle.md`). If only one folder can attach, attach `Trading-Agent/` and keep them under the same vault so the relative path `../Finance-Research/Signals/` resolves.
3. Paste the contents of `Trading-Agent/CLAUDE.md` into the project instructions (or rely on auto-load since it's the folder's CLAUDE.md).

## 2. Confirm env vars (already set in Project 1)
The same six variables are reused: `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL` (= the **paper** URL), `FINNHUB_API_KEY`, `FRED_API_KEY`, `DISCORD_WEBHOOK_URL`. Confirm `ALPACA_BASE_URL` is `https://paper-api.alpaca.markets`.

## 3. Verify the Alpaca paper connection BEFORE any trading
Ask the agent (or run via the routine) to fetch `/v2/account` and `/v2/positions` and print equity + positions, then match the Alpaca dashboard. (Endpoints in `scripts/alpaca-rest.md`.) Numbers match = wired correctly.

## 4. Create the 5 routines (or I'll schedule them for you)
Local to start. Each: point at the project/folder, paste the matching prompt, strongest Claude model, set the cron (ET, weekdays):

| Routine | Paste from | Schedule |
|---|---|---|
| Pre-Market | `routines/01-pre-market.md` | 07:30 |
| Market Open | `routines/02-market-open.md` | 09:35 |
| Midday | `routines/03-midday.md` | 12:00 |
| Close / Journal | `routines/04-close.md` | 15:45 |
| Weekly Review | `routines/05-weekly-review.md` | Fri 16:15 |

> Tell me "schedule Bull for me" and I'll set these up as scheduled tasks like the morning brief.

## 5. Dry runs (paper) — watch them
"Run now" each routine 2–3×, read the full transcript, confirm: account reads correctly, a paper order places + fills + logs with a thesis + stop, sizing caps a position at 40%, the −10% daily halt and −12% cut behave, the close run journals + notifies. Tune prompts/keys until clean.

## 6. Go 24/7 (remote) — when it behaves
1. Push `Trading-Agent/` to a **private GitHub repo**.
2. Claude Desktop → Routines → recreate each as **Remote**, pointed at the repo + the prompt file.
3. Add the six keys to the routine's **cloud environment** variables (never in the repo).
4. Enable **"allow unrestricted branch pushes"** so memory commits persist; confirm each prompt commits.
5. "Run now" remotely 1–2× and verify the commits land on main.

## 7. Dashboard (free Netlify subdomain) — see `dashboard/README.md`
Import the repo to Netlify, publish `Trading-Agent/dashboard`, add `trading.cjstancin.com`. The routines publish `dashboard/data/status.json`; Netlify auto-redeploys on each commit.

## Guardrails recap (don't skip)
Paper only (live is LOCKED). Stop on every entry. Daily halt −10%, monthly kill −30%. Never widen a limit without approval. Log every trade with a thesis. Keys in env vars only.
