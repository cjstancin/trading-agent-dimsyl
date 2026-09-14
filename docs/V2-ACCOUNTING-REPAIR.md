# Execution balances and undelivered corporate entitlements

The reviewed policy keeps broker-confirmed cash and shares in the executable ledger. A dividend
announcement or stock split is an economic right, not evidence that the paper broker delivered
cash or shares. `corporate_entitlements` records those rights separately. The settled-cash gate and
order gateway never count them as cash or sellable shares.

The September incident repair is deliberately bounded. It verifies the complete inception-to-capture
fill history against broker activity, matches every trade cash reference, matches the original seed
to its journal, and accepts only the documented FILL/FEE/JNLC activity set. A new distribution,
stock delivery, journal, open order, multi-lot split, disposal of the affected split lot, changed basis,
or unexplained position/cash difference stops the plan for separate review. It never manufactures a
trade or cash balancing entry. The remaining sub-cent difference must reconcile at broker cent precision.

## Source and derived history

- Original fills, cash credits, corporate markers, approvals, lots' provenance/basis and saved marks
  remain as evidence. Unsupported cash credits get individually referenced inverse `adjust` entries.
- Broker fee IDs are retained verbatim as idempotent `fee` references.
- Only proven doubled split quantities are restored; the undelivered remainder is a separate right.
- Historical dividend eligibility uses signed fills strictly before the New York ex-date, including
  DST. A sale on the ex-date does not remove eligibility. Ambiguous distribution components and
  post-split entitlement reconstruction fail closed.
- `accounting_marks` holds execution and economic restatements with source hashes. `equityCurve`,
  sleeve benchmarks, statements and the live gate read the economic overlays. Altered source marks
  invalidate the overlay. Original marks are not rewritten.
- New marks store executable cash/positions and economic equity; `accounting_mark_rights` records
  the separate cash and stock-right valuation that explains the difference. Late verified fees and
  newly established dividend rights add `accounting_cash_overlays`; sleeve deltas use aggregate
  before/after D9 allocation. The derived brake peak is recomputed, without clearing any halt or
  changing the brake tier. Saved prices and executed trades are held fixed: this is a restatement,
  not a counterfactual strategy replay.
- Monthly disposal P&L remains execution-lot P&L; it is not mislabeled as economic distribution P&L.

## Recurrence protection

After the reviewed repair enables `accounting:policy`, the ordinary fill replay also requires a
complete broker cash-activity read scoped to `category=non_trade_activity` from the verified book
inception. The live paper endpoint retained all eleven fee receipts and the seed journal while
excluding all 52 fills; it also avoids a fixed allowlist dropping unfamiliar nontrade types. A cap
failure latches an explicit accounting halt. It ingests exact negative fee receipts once. New/unmatched
cash or stock distributions are held for an independently reviewed entitlement settlement; their
arrival is never guessed from the payable date. New journals also require review. Missing cash
evidence or an unexplained cash difference of at least half a cent fails reconciliation and halts
the book. Repeated unresolved receipts retain their evidence without timestamp churn, but still
re-arm the halt if it was cleared without settlement. Acknowledging an incident is not settlement;
that requires a new reviewed financial adjustment. No automatic repair or halt clearing is included.

Corporate polling includes recently closed positions and a 45-day lookback. Proven historical
dividends are recorded as nonspendable rights; future ex-dates wait. Pending/stale incident records
remain in the database, with reviewed entitlement rows providing their accounting disposition.
Pre-inception ex-dates are known to have no rights in this initially empty book; old lookback
announcements cannot create a permanent pending valuation gate.
Future forward splits remain contained until the executable versus economic split is reviewed.
Historical forward-split announcements with proven zero holdings before the ex-date are ignored
under the reviewed history policy, including retained announcement-only pending records. Their
evidence and any existing halt remain unchanged. Legacy split mutations, missing history and
future pending evidence remain contained.

## Review and application runbook (coordinator only)

1. Keep the book halted. Pause/drain the exact Bull and deployment controls that can change the
   database/code; preserve their original states. Confirm no outstanding broker orders. Never enable
   disabled timers or send an order as a test.
2. Run the reviewed `agent/scripts/capture-accounting-evidence.cjs` on the VPS as root. It reads
   the existing private environment in-process, asserts the paper host, makes only GET requests,
   and creates a private `/tmp/bull-accounting-20260914-*` directory. It snapshots SQLite through
   the backup API and checks financial fingerprints plus broker cash/shares before/after. No secrets
   or holdings dump are printed. A source snapshot is not a live database backup replacement;
   also preserve the coordinator's normal pre-apply backup.
3. Generate the plan from that snapshot. All CLI paths are explicit and output creation is exclusive:

   ```bash
   node --import tsx src/v2/accounting-cli.ts plan --db /private/snapshot.sqlite --evidence /private/evidence.json --output /private/reviewed-plan.json
   ```

4. Review the exact source SHA and the plan's **financial `reviewHash`** with independent Codex and
   Claude reviewers. It binds all guarded rows, cash, share quantities/basis, activities, corporate
   terms, account status/trading-blocked flag, entitlements and correction arithmetic. Only capture
   timestamps, the full audit hash, and unused live quote-derived account equity are excluded from
   this stable review view. The full fresh capture hash and time are retained in the application journal.
   A financially identical recapture therefore retains the approved hash; changing any bound value
   requires a new reviewed financial hash. The apply operation derives the plan again from fresh
   evidence, checks its stable hash against the approval, requires the account active/unblocked,
   and independently enforces actual wall time with evidence no more than ten minutes old. Never
   bypass a changed financial hash, substitute an old timestamp or use a simulated clock in production.
5. Only the coordinator applies after release and final comparison. This command is intentionally
   absent from npm startup/ritual scripts:

   ```bash
   node --import tsx src/v2/accounting-cli.ts apply --db /home/cj/bull/agent/runtime/v2/bull.db --evidence /private/fresh-evidence.json --plan /private/reviewed-plan.json --reviewed-hash EXACT_FINANCIAL_REVIEW_HASH
   ```

   The exact financial review hash, financial evidence hash, fresh read, standing book halt and all row guards
   are checked under `BEGIN IMMEDIATE`. All changes commit together. Repeating that exact applied
   plan is a no-op; a conflicting ID/hash fails.
6. Reconcile using read-only broker account/positions/activity queries, inspect economic and execution
   views, fees, all sleeve series, brake peak/tier and gate state. Do not invoke an order-capable
   ritual merely to test the repair. No blanket `clearState` belongs in the repair. Clearing a halt
   is a separate coordinator decision after fresh reconciliation and review.
7. Restore every control changed for the window and retain the receipt.

## Compensating inverse and code rollback

`reverse --db PATH --reviewed-hash EXACT_PLAN_SHA256` is an immediate compensating inverse only.
It refuses any changed post-apply financial/evidence row, requires the standing book halt, preserves
original cash/fee/mark evidence, appends inverse cash entries, restores the original two quantity
fields and policy/peak before-values, and marks its rights/overlay journal inactive. It never clears
the original halts. After later activity, use a new independently reviewed adjustment plan instead.
The bounded repair refuses a pre-existing derived accounting epoch. The inverse also requires the
post-apply rights/overlay tables to remain empty, so it cannot leave untagged derived marks that a
future activation could resurrect. Historical restatements are tagged with the repair ID and become
inactive when its journal is reversed; entitlement rows are retained as void audit records.

Code rollback alone is unsafe after policy activation: old code does not understand entitlements
or economic overlays. Keep the book halted and the affected timers stopped until the matching
reviewed inverse or forward fix is complete. New tables are additive and remain as audit evidence.

## Verification

`npm test` includes offline accounting tests for exact execution/economic separation, ex-date/DST
eligibility, unchanged source evidence, idempotency, wrong/stale/changed guards, transaction rollback,
compensating inverses, fee conflicts, unmatched receipts, late fee/right overlays and cash mismatch.
The coordinator also runs a disposable copy proof against the private captured incident snapshot.
That proof uses a clearly labeled simulated clock and does not authorize production application.

Broker API contract: [Alpaca account activities](https://docs.alpaca.markets/us/reference/getaccountactivities-2).
