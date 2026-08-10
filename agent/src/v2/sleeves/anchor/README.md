# Anchor sleeve — 13F best-ideas clone (Bull v2)

Clones the top-5 holdings of four CJ-LOCKED managers into equal slots of the anchor sleeve
(25% of the book, config `book.sleeveSplit.anc`). Paper-only, order-gateway-only, approvals-queue-only —
the sleeve **never** swaps a manager, never guesses a ticker, and never reads `buying_power`.

Managers (config `anchor.managers` — CJ edits this, code never does):

| Manager | CIK | Note |
| --- | --- | --- |
| Berkshire Hathaway | 0001067983 | transition-watch |
| TCI Fund Management | 0001647251 | |
| AltaRock Partners | 0001631014 | |
| Himalaya Capital | 0001709323 | |

## Module map

| File | Role | Pure? |
| --- | --- | --- |
| `types.ts` | Shared types + the three ports (Edgar / Mapping / Price) | — |
| `infotable.ts` | 13F info-table XML → normalized lines (thousands→dollars rule) | yes |
| `edgar.ts` | Live EDGAR adapter (throttled ≤2 req/s, declared User-Agent) + pure index/file/amendment parsers | adapter no, parsers yes |
| `mapping.ts` | CUSIP→ticker: fixture adapter (tests/overrides) + OpenFIGI real adapter | port |
| `clone.ts` | THE clone math: filter → top-5 → recursion drop → 40%-cap water-fill → aggregate; `summarize`; re-trade gate | yes |
| `store.ts` | `anc_filings` (amendment law: RESTATEMENT replaces, NEW HOLDINGS adds) + `anc_builds` + approvals writes | db |
| `drift.ts` | 7 drift-watch detectors + filing-deadline math + `flagDrift` | detectors yes |
| `prices.ts` | Price port (Alpaca real / fixture) + TTM performance-guard math | port |
| `planner.ts` | Target-vs-ledger diff, 20% relative drift band, manager-follow sells first, `executePlan` via the shared gateway | plan yes |
| `bench.ts` | Annual bench-refresh report generator → approvals queue (design decision #2) | yes |
| `index.ts` | Orchestration: `runFilingEvening` / `watchAmendments` / `tradeNextOpen` | — |
| `fixtures/*.xml` | Authored minimal info tables: option row (TCI), parking ETF (AltaRock), BRK.B recursion (Himalaya), RESTATEMENT /A | — |

## Scheduler contract (the book layer wires this)

All four managers are deadline-day filers (Feb 14/17 · May 15 · Aug 14 · Nov 14, usually after
16:00 ET). Next drop: **Fri 2026-08-14** (period 2026-06-30).

1. **Filing evening** (deadline day, ~20:00 ET):
   `runFilingEvening(db, ports, loadConfig(), { period, today })` — fetch/parse/store, rebuild the
   clone, run the re-trade gate + drift-watch, queue flags. Leaves `state anc:pending_rebuild`
   when the gate passes. Idempotent — safe to re-run.
2. **Next market open**:
   `tradeNextOpen(db, broker, prices, loadConfig(), { asOfDate, sleeveEquity9 })` — plans against
   live prices + the ledger and executes through `placeOrder`. `sleeveEquity9` comes from the book
   layer (`seedSleeveEquity9(cfg)` before the first build).
3. **Amendment watch** (daily-ish while `inAmendmentWindow(period, today, cfg)`, ~60 days):
   `watchAmendments(db, ports, cfg, { period, today })` — new /A accessions are stored
   (restatement replaces the table), re-cloned, and re-gated. Berkshire's confidential-treatment
   reveals and the Himalaya-style restatement both land here.
4. **Annual bench refresh** (once a year): `benchReport(...)` + `queueBenchReport(db, report)` over
   researched candidate inputs — a report into CJ's queue, never an auto-swap.

## Behavior rules (locked design, tested)

- **Clone**: top-5 by value per manager · non-equity filtered BEFORE selection (options, PRN debt,
  parking ETFs, non-common classes) · BRK.A/B dropped from other managers' top-5 (recursion) with
  renormalize — the #6 name is never promoted · 40% of-slot line cap with proportional water-fill ·
  duplicate tickers merge across managers · Σ weights == 1.0 exactly (allocate9, no dust).
- **Re-trade gate**: only on top-5 membership change or a >2pp aggregate weight move
  (`anchor.retradeWeightMovePp`, strict >: 2.0pp holds, 2.1pp trades).
- **Rebalance band**: 20% relative (`anchor.driftBandRel`, strict >). Manager-follow exits always
  trade, sells before buys. No stops, no LEI dial — the sleeve deliberately buys fear.
- **Drift-watch** (all seven → `approvals` kind `anchor-drift`, warn/eject, never auto-act):
  deconcentration · name churn · weight turnover · market-adjusted AUM anomaly ·
  representativeness · performance guard (TTM vs SPY, two-strike eject) · liveness
  (5 days late warns; ADV deregistration instant-ejects).
- **Mapping failures** → `approvals` kind `anchor-mapping`; the line is dropped and the slot
  renormalized — never guessed.

## Tests

```
cd agent && npx tsx src/test-v2-anchor.ts
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict \
  --skipLibCheck --esModuleInterop --resolveJsonModule src/test-v2-anchor.ts
```

115 offline checks; fixtures under `fixtures/`. The live EDGAR + OpenFIGI adapters are the only
untested-by-policy surfaces (network); everything below them is exercised.
