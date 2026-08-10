# Insider sleeve (`ins`) — Bull v2

Cluster-buy follower over SEC Form 4 filings. Paper-only, like everything in Bull v2.
Implements the locked v2 design (vault: 2026-08-10 design doc); all thresholds live in
`agent/config/v2.defaults.json` under `"insider"` and are journal-amendable — nothing numeric
that exists in config is hardcoded here.

## The signal, in one paragraph

≥3 distinct insider CIKs make open-market purchases (code **P** only, non-derivative table,
`acquiredDisposedCode="A"`) in the same stock within a **10-calendar-day** rolling window keyed on
trade date, each ≥ **$10k**, ≥ **$100k** in aggregate, with ≥1 officer or ≥2 directors and ≥2
participants who aren't pure 10%-owner vehicles. 10b5-1 plans are excluded twice over (the
`aff10b5One` checkbox — live-verified on schema X0609 — plus a `/10b5-?1/i` footnote regex);
DRIP/ESPP/401(k) plumbing is excluded; an insider who bought in this same calendar month in each
of the 3 prior years is a routine buyer and is dropped. M-exercises appear as acquisitions and are
**not** buys — the code-P filter catches them. First-ever buys earn a score bonus.

## Module map

| file | role |
| --- | --- |
| `ports.ts` | Every network source behind an interface: `EdgarPort`, `MarketPort`, `SectorPort`, `PricePort`. All tests run offline against fixtures. |
| `form4.ts` | Form 4 XML parser (regex/string extraction, zero new deps — see the header for why that's safe on EDGAR's fixed schema) + transaction classification (buy / sell / excluded-with-reason). |
| `edgar.ts` | LIVE EDGAR adapter: declared User-Agent (403 without it), serialized ≤2 req/s throttle, Atom feed / daily index / filing / companyfacts shares-outstanding. |
| `market.ts` | LIVE Alpaca adapters: daily bars + latest quote (data host, `feed=iex`), asset metadata (trading host), market cap composed as EDGAR shares × quote mid. `SectorPort` is a **stub** (returns null). |
| `store.ts` | Private tables (`ins_accessions`, `ins_filings`, `ins_clusters`, `ins_signals`) via `CREATE TABLE IF NOT EXISTS` — shared `db.ts` is never touched. Excluded transactions are stored WITH their reason (audit trail). 4/A supersede-by-transaction-key lives here. |
| `cluster.ts` | Pure cluster engine: rolling window, $ thresholds, role gate, routine-buyer screen, scoring (breadth + role pts CFO 1.5 > CEO 1.25 > officer/dir 1.0 + log10 size + Δown% conviction + first-ever bonus). |
| `liquidity.ts` | 21-day median dollar volume ≥ $300k · price ≥ $2 · mcap ≥ $75M · exchange-listed · spread ≤ 1.5% of mid. Everything fails **closed**. |
| `planner.ts` | Capacity (slots = clamp(⌊sleeve$/500⌋, 2, 8), slot $300–600), pure `decideEntries` (one-per-ticker, ≤2 same-sector, floor, spread, slots, fractionable-or-whole-share-limit-at-mid fallback, `SKIP_NOT_FRACTIONABLE`), and `executeEntries` which routes every funded order through the ONE order path (`order-gateway.placeOrder`). |
| `exits.ts` | 126-trading-day horizon, reversal (≥2 participant sellers or one >50% seller → sell), one-time clock reset capped at 9 months, amendment-killed cluster → `ins-thesis-review` approvals row (**never auto-sell**), ATR stop → `stop_fired` EVENT only (state key `ins:stop_fired:{SYM}` + position_meta) — the −25% floor and the sell decision belong to the judgment layer. |
| `shadow.ts` | Shadow book + CAR(21/63/126) vs IWM (benchmark symbol from config `benchmarks.ins`). |
| `ingest.ts` | Atom/daily-index parsing (dedupe by accession — index rows repeat per FILER), poll-window guard (weekdays 06:00–22:05 ET), jittered 2–5-min delay helper, per-accession pipeline with 4/A re-qualification. |
| `fixtures/` | Real-shaped Form 4 XMLs: clean P-buy, M-exercise, 10b5-1 checkbox (X0609), 10b5-1 footnote (X0409), DRIP footnote, 4/A amendment; plus an Atom page and a daily form index. |

Tests: `agent/src/test-v2-insider.ts` — `cd agent && npx tsx src/test-v2-insider.ts` (offline,
`:memory:` SQLite, mock broker/ports; 136 checks).

## Honesty note — what year 1 can and cannot tell you

**Year-1 P&L cannot validate this sleeve.** At 2–8 funded slots and ~3–10 qualifying clusters a
month (lumpy — droughts are normal), the funded book produces maybe 4–8 round trips a year: pure
noise. The shadow book is the honest evaluator — EVERY qualifying signal is logged with its
funded/skip status and accrues 21/63/126-day CARs against IWM, giving 40–100+ observations a year.
Judge the sleeve on shadow CARs; treat the funded book as an execution-fidelity check, not
evidence. Skip reasons are recorded per signal precisely so the funded book's selection bias is
measurable.

Also by design: the LEI dial does NOT apply to this sleeve (contrarian by construction — exempt),
and reversal/horizon exits sell, but amendments and price stops never do on their own.

## REAL vs STUBBED

- **REAL:** EDGAR adapter (Atom, daily index, filing fetch with index.json→XML + full-text
  fallback, companyfacts shares outstanding) with declared UA + serialized 500ms-gap throttle;
  Alpaca quote/bars/asset adapters; market cap = EDGAR shares × quote mid. None of these run in
  tests (fixtures only) and none have been fired at the live endpoints from this module yet —
  first live poll should be watched for parser drift.
- **STUBBED:** `SectorPort` (returns null → the sector cap deliberately cannot fire on unknowns;
  fail-open for the cap only, documented in `market.ts`). Phase 4/5 must supply a real source.
- **Judgment layer:** consumes `ins-thesis-review` approvals rows and `ins:stop_fired:*` state
  keys; owns the −25% floor and all thesis-check sells. Not built here, by design.

## Integration contract (what Phase 4/5 must wire)

1. **Scheduling:** call `ingest.pollOnce` on a `pollDelaySeconds(cfg)` cadence while
   `shouldPollNow(etWeekday, etHHMM)`; call `ingest.reconcileDaily(date)` nightly after 22:05 ET;
   after any pass that stored qualifying buys, run `detectClusters` over
   `store.qualifiedBuyEvents` + `store.ownerHistoryFn`, then next morning at the open:
   `gatherSnapshots` → `decideEntries` → `executeEntries` (the spread gate re-runs at open because
   the same `decideEntries` runs on fresh quotes). `shadow.updateShadowCars` nightly.
2. **Sessions:** `runExits` needs the ascending trading-day list (Alpaca `/v2/calendar` via the
   existing ReadPort/market-calendar) and a `latestPrice9` callback.
3. **ATR params:** insider config carries no ATR dials; pass `{days, multiple}` explicitly
   (wildcard uses 14/2.5) — the stop only ever emits an event.
4. **Reconcile:** actual fill prices land via the shared Phase-1 fill replay; `entry_px9` recorded
   at decision time is the decision-mid reference (documented proxy) until then. Closed positions'
   `position_meta` rows are cleared by shared reconcile, not this sleeve.
