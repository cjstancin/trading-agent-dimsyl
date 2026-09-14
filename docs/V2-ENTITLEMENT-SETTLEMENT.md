# Reviewed paper entitlement settlement

This is a separate forward-only workflow after the September accounting repair. Do not rerun the
repair or clear a halt to process a distribution. The normal reconciliation path continues to hold
unmatched deliveries. Acknowledging an approval is not financial approval of a settlement plan.

The command supports one complete ordinary DIV cash receipt or one SSP share receipt against an
existing right. The cash rate, eligible quantity and rounded payment must agree. Split delivery
requires one untouched, unwashed lot, no disposals or prior split settlement, exact extra shares and
unchanged total basis. Partial deliveries, multiple distributions, fees not yet ingested, ambiguous
types/allocations and conflicting entitlement claims require separate review; no balancing plug.

1. Preserve the current control state and stop the Bull writers in a new maintenance window. Use
   the existing standing book halt from the unmatched receipt. Do not invent a halt merely to bypass
   the guard. Preserve a private SQLite backup and fresh broker evidence. This workflow places no orders.
2. From `agent/`, plan with `node --import tsx src/v2/entitlement-settlement-cli.ts plan --db PATH
   --env PRIVATE_ENV --entitlement ID --activity BROKER_ACTIVITY_ID --output PRIVATE_PLAN`.
   Planning opens SQLite read-only and performs paper-broker GETs only, including complete inception
   activity pagination and two account/position/order snapshots. Output is private and exclusive-create.
3. Have an independent reviewer approve the exact printed SHA256 after inspecting the broker receipt,
   entitlement, allocation, full cash/position agreement and source rows. Plans contain private broker
   evidence; do not publish them or paste their bodies in chat.
4. Apply with `node --import tsx src/v2/entitlement-settlement-cli.ts apply --db PATH --env PRIVATE_ENV
   --plan PRIVATE_PLAN --reviewed-hash HASH`. Apply captures the broker again, refuses stale/changed
   evidence, locks SQLite, recomputes the full plan and requires the same hash. The capture must be
   under ten minutes old and its activity window within one minute of observation. No clock override.
5. Independently reconcile read-only before separately reviewing the original hold's disposition.
   Restore only the controls this maintenance window stopped. This command never clears halts,
   approvals, conflict evidence, original rights, marks or split markers. A repeated apply refuses
   without financial writes; normal broker replay recognizes the exact recorded activity hash.

`entitlement_settlements` is an append-only receipt journal. A dividend adds actual cash and retires
the economic right on its delivery date; a cent-rounding difference is a dated derived overlay.
A split updates the reviewed lot's two quantities with total basis intact and journals the delivery;
no fictional trade fill. Historical rights remain visible before receipt and cannot double-count
afterward. Subsequent dividend history includes delivered shares; unresolved stock rights still gate
complex eligibility. Original historical marks remain immutable.

Source rollback after any settlement is unsafe: older readers do not retire journaled rights. Keep
the new readers or design a separately reviewed forward correction. No production settlement is
implied by shipping this code. Actual receipt review remains mandatory.

Reference: https://docs.alpaca.markets/us/docs/account-activities (Trading API DIV/SSP vocabulary).
Broker API/SSE vocabulary is different; unsupported formats remain held, never guessed.
