---
type: "memory"
file: "portfolio"
date: "2026-06-19"
updated: "2026-06-19 14:30 UTC"
---

# Paper Portfolio — Bull (Alpaca PAPER)

> Last verified from Alpaca API: **2026-06-14** (API inaccessible from cloud run environment — see BLOCKER below).
> Last Bull daily run: **2026-06-19** (Juneteenth — market CLOSED, no new trading data).

## BLOCKER: Alpaca API Network Access
The cloud execution environment (claude.ai/code remote) does NOT have egress access to `paper-api.alpaca.markets`.
All attempts to GET /account or /positions return: *"Host not in allowlist: paper-api.alpaca.markets"*

**CJ action required:** Add `paper-api.alpaca.markets` and `data.alpaca.markets` to the network egress allowlist in the environment's network policy settings. See: https://code.claude.com/docs/en/claude-code-on-the-web

Until fixed, Bull cannot: verify equity, check positions, or place orders. All figures below are **last known / estimated**.

---

## Account Summary (last known: 2026-06-14)
| Field | Value |
|-------|-------|
| Equity | $100,000.00 |
| Cash | $100,000.00 |
| Buying Power | $100,000.00 (no margin) |
| Open Positions | 0 |
| Day P&L | $0 (0.0%) |
| MTD P&L | $0 (0.0%) |
| vs S&P 500 | ~−2.4% (SPY up ~2.4% since account start; we've made no trades) |

**MTD circuit breaker:** NO (0% MTD, far above −25% kill-switch)
**Daily halt:** NO (0% today)
**Regime (VIX ~16.4, June 16):** NEUTRAL (16–24 band) → trim new sizes ~25%

---

## Open Positions
*None — account is fully in cash.*

---

## Intended Trades (blocked — Alpaca API inaccessible)
The following trades were researched and sized for Monday June 22 open. They CANNOT be executed until CJ resolves the API access issue.

### 1. MRVL (Marvell Technology) — S&P 500 Index Inclusion Catalyst
| Field | Value |
|-------|-------|
| Side | BUY (limit) |
| Entry | ~$312.00 |
| Stop (20% trailing) | ~$249.60 |
| Risk/share | $62.40 |
| Shares (7% risk, NEUTRAL −25%) | 84 shares |
| Total cost | ~$26,208 (26.2% of equity ✓) |
| Price targets | $345 (B. Riley) / $385 (KeyBanc) |
| Thesis | MRVL joins S&P 500 at close June 22 → passive funds MUST buy ~$10B+ in MRVL. AI data center networking chips (works with NVDA). Strong Q1 FY27 earnings (GAAP profitable). Price has already run from ~$200 in late May — some inclusion premium is priced in, so risk a smaller size. |
| Risk note | Has run ~55% since late May; "buy the inclusion" may be partly priced in. Watch for post-inclusion dip for secondary entry. |

### 2. NVDA (Nvidia) — AI Chip Leader, Pulled Back from ATH
| Field | Value |
|-------|-------|
| Side | BUY (limit) |
| Entry | ~$205.00 |
| Stop (20% trailing) | ~$164.00 |
| Risk/share | $41.00 |
| Shares (7% risk, NEUTRAL −25%) | 127 shares |
| Total cost | ~$26,035 (26.0% of equity ✓) |
| Price targets | $298 avg analyst (62 analysts, Strong Buy) |
| Thesis | NVDA pulled back ~13% from ATH of $236.54 (May 14). Forward P/E ~25× is very reasonable for NVDA's AI dominance. Demand from hyperscalers remains at record levels. Momentum leader in strongest sector. |
| Risk note | CJ's real Fidelity account has 0.824 shares NVDA ($174 value) — minimal real-book exposure, no conflict. |

**Sector check after 2 trades:** MRVL + NVDA = $52,243 = 52.2% in Semiconductors (below 60% cap ✓)
**Cash remaining after 2 trades:** $47,757 (47.8% — well above 10% buffer ✓)
**Open positions:** 2 (below 8 cap ✓)

*Would consider QQQ (broad tech ETF, ~$722, pulled back 1% on Fed hold) as a 3rd position — $26k = 26% more, leaving ~$22k (22%) in cash.*

---

## Guardrail Status (as of 2026-06-19)
- [ ] MTD kill-switch (−25%): NOT triggered (0% MTD)
- [ ] Daily halt (−8%): NOT triggered
- [x] Market CLOSED: Juneteenth (June 19) — no new entries today
- [ ] API access: BLOCKED (see above)
- [ ] Market open next: Monday June 22 — MRVL S&P 500 inclusion day

---

## History
| Date | Event |
|------|-------|
| 2026-06-14 | Account initialized at $100,000 |
| 2026-06-19 | Daily run; market closed (Juneteenth); API blocked; research completed; intended trades documented |
