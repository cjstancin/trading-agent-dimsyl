# Momentum sleeve (`mom`) — Bull v2

40% of the book. 12-1 cross-sectional momentum over S&P 500 + S&P 400, quality-vetoed, FIP-smoothed,
equal-weight top-N, monthly rebalance with a hold band. Paper-only, like everything in v2.

## Module map

| File | Role |
| --- | --- |
| `schema.ts` | Private `mom_*` tables (`CREATE TABLE IF NOT EXISTS` — never touches `v2/db.ts`) |
| `ports.ts` | Port interfaces (Universe / Assets / Price / Fundamentals) + config shape + month math |
| `signal.ts` | **Pure core**: 12-1 return, deterministic tiebreaks, vetoes, FIP re-rank, hold-band selection, N schedule, vol-brake math |
| `planner.ts` | **Pure** `planRebalance` (d9 notionals, weight band, min-order, deployScalar) + `executeRebalance` (sells → terminal → buys through the shared order gateway) |
| `universe.ts` | Universe build (Wikipedia ∩ Alpaca assets ∩ ≥13 closes), monthly snapshot (survivorship-free archive), >15% MoM delta → pending `approvals` row |
| `month-end.ts` | Month-end ritual glue: snapshot → delta check → per-name inputs → ranks persisted to `mom_ranks` → both shadow books advanced |
| `wikipedia.ts` | REAL scraper for the two list pages (header-driven column parse, plausibility floors, loud failure) |
| `alpaca-ports.ts` | REAL price adapter (data host, `adjustment=all&feed=sip`) + assets adapter (paper-host-guarded, read-only `/v2/assets`) |
| `edgar.ts` | REAL companyfacts adapter (declared UA, ≤2 req/s, quarterly cache in `mom_facts_cache`) + pure tag-fallback extraction (`extractFundamentals`) |
| `shadow.ts` | Shadow books: `shadow50` (recipe at N=50, $0 cost — the real evaluator vs QMOM) + `mirror` (live N, $0 cost); `compareBooks` |
| `honesty.ts` | Honesty ledger: 5 bps/side + $0.01/sell per real order intent. **Analytics only — never the tax ledger** |
| `fixtures.ts` | Offline fixtures + in-memory ports (tests only) |

Tests: `agent/src/test-v2-momentum.ts` — `cd agent && npx tsx src/test-v2-momentum.ts`. Zero network.

## Operating cadence

1. **Month-end close** → `runMonthEnd(db, ports, cfg, "YYYY-MM", sleeveUsd)`; signals + snapshot +
   shadow books. Idempotent (REPLACE everywhere).
2. **First trading day, 10:30–15:00 ET** → mark holdings, `planRebalance(...)`, then
   `executeRebalance(...)`. Once-per-day state guard (`mom:rebalance-done:<date>`, `force` to
   override). Sells submit first and are polled to terminal before any buy hits the settled-cash gate.

## Deliberate calls (read before arguing with the code)

- **Exits are rank-out only.** No per-name stops; a holding vetoed or dropped from the top-50 has no
  rank and exits the same way. The book brake owns disasters.
- **Rank-out sells ignore the $25 min-order filter** — the monthly re-rank is the exit mechanism and
  must always fire. Band trims/adds and new buys respect it.
- **`deployScalar` scales NEW-name buys only** (contract wording: "NEW-BUY sizing only"). Band adds
  of names already held are rebalances, not new deployment, and stay unscaled.
- **Vol brake defers ALL adds** (new buys + band adds); sells always run — risk-off is never deferred.
- **`buyFromTop`/`sellBelowRank` are literal config dials (10/25).** At N>10 the buy band can be
  narrower than the slot count; the book then runs short and fills next month. Raising the dial is a
  config amendment, not code.
- **Missing fundamentals = veto**, per contract — including the edge where a zero-debt filer has no
  debt tags at all (Financials/REITs, where that bites most, skip the debt check by GICS sector).
- **T+1 reality:** same-day sale proceeds are unsettled, so first-day buys draw on previously settled
  cash; what doesn't fit is SKIPPED + recorded by the gateway (`NO_SETTLED_CASH`), and a follow-up
  run the next day (with `force`) completes the buys. Never forced, never silent.

## REAL vs test-injected

The Wikipedia, Alpaca and EDGAR adapters are real, production-shaped code paths (UA declared, rate
limits, caches, paper-host guard) — but nothing in the test suite touches them over the wire, and
they have not been exercised against live endpoints from this environment. First live month-end run
should be watched: `feed=sip` historical bars require the account's data subscription to allow it.

## What the book layer must supply

- `sleeveEquity9` / `sleeveUsd` (the sleeve's slice of book equity) — sizing + N schedule + mirror book.
- `deployScalar` from the LEI dial (1.0 / 0.7 / 0.55).
- Scheduling: month-end trigger and first-trading-day trigger inside the ET window; market-day checks
  via `market-calendar.ts`.
- Marks for current holdings (`latestPrice` or last close) when building `planRebalance` input.
- `loadConfig()` plumb-through: `config.momentum` (this sleeve never reads dials from anywhere else)
  plus `ledger.washBlacklistDays` and `version` for `executeRebalance`.
