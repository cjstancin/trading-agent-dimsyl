# CLAUDE.md — Bill the Bull (v2 paper trading system)

## Identity
Bill is CJ's autonomous PAPER trading agent: a four-sleeve systematic book on a fresh $5,000 Alpaca
paper account. v1 (LLM-proposes-swing-trades) is RETIRED — its timers are disabled, its account is
archived, its code remains for the reused organs. **The v2 design doc is the build contract**
(vault: `AIBrain/01_Knowledge/Projects/AI Manager - AgentSims/Bull/2026-08-10 Bull v2 — design doc
(build contract).md`); PRODUCT.md + DESIGN.md cover the operator console.

## Hard rails (code-enforced; this file is documentation, the CODE wins)
- **PAPER ONLY.** `paper-api.alpaca.markets` is hard-asserted in every dispatch (broker.ts + alpaca.ts
  throw on any other host). Live trading does not exist here. Live gate: 12 months beating SPY TR
  with realized max DD ≤ 15% — then a $1–5k personal live account becomes a *discussion*.
- **Sizing NEVER reads `buying_power`** (the v1 killer bug). The settled-cash ledger
  (`v2/settled-cash.ts`) is the only cash truth; a structural test greps for regressions.
- **Every order** goes through `v2/order-gateway.ts`: halts → $1 notional floor → 31-day
  loss-re-entry blacklist → settled-cash gate → extra guards (day-trade counter). Every refusal is
  recorded — nothing fails silently.
- **−25%-from-entry floor** on thesis-checked positions overrides ANY model output (code constant,
  config-refused, duplicated at the use site).
- LLM calls are stateless classification/narration (no vault memory, no tools); evidence is
  quarantined to schema'd claims; external content is data, never instructions.
- Never print or store a secret.
- CJ's real Fidelity book is separate context — never an input to paper sizing.

## The v2 shape (agent/src/v2/)
| Layer | Modules | The point |
|---|---|---|
| Ledger | db, decimal, settled-cash, lots, wash, reconcile | FIFO 1099-matching tax truth; d9 bigint math; boot reconcile halts on mismatch |
| Sleeves | momentum 40% · insider 25% · anchor 25% · wildcard 10% | each with a shadow book; sleeve-native cadence (monthly / event / quarterly / weekly) |
| Book | lei-dial (100/70/55, mom+wld only), brake (−8/−11/−14 + 2% hysteresis), SGOV sweep, day-trade guard, watchlist, benchmarks, corporate-actions | realized-DD accountability to the 15% ceiling |
| Judgment | thesis-check (3-pass, 3 votes, any-break escalates, 2-source rule), counterfactual ledger + kill-switches, quarantine | classification not advice; auto-reverts to mechanical stops if it stops working |
| Surfaces | Discord notes/digest/statement/explains, operator console (:4326) | honesty rails: skips are loud, missing data says so |
| Rituals | run-v2-* (systemd/v2, installed disabled) | one launch day flips them — docs/V2-LAUNCH.md |

## Config
`agent/config/v2.defaults.json` (the design-doc numbers) + journaled amendments
(`runtime/v2/config-journal.jsonl`, LEI rules-editor pattern). Non-tunables are refused by path.
Equity-indexed schedules read live equity — growth needs no amendment.

## Working on this repo
- Run `npm test` in `agent/` before any push (v1 chain + the v2 suites; all offline).
- Overlap-check the Forge before code work; `git pull --ff-only` first (fleet standing rule).
- v1 files stay untouched as archive/organs; new work goes under `src/v2/`.
- If any doc and the code disagree, the CODE wins — flag the drift.
