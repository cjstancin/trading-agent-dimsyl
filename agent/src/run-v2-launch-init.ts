// Bull v2 — launch-day bootstrap (docs/V2-LAUNCH.md §2). One-time, idempotent, LOUD:
//   1. verifies the paper account (host assert already ran at import) and that its cash matches the
//      $5,000 design seed — a mismatch HALTS the launch, it never "adjusts"
//   2. seeds the settled-cash ledger (ref="seed" — re-running is a no-op)
//   3. reports mode + judgment state + config version so the flip is made with eyes open
// It places no orders and enables no timers — those are CJ's runbook steps.
import "./load-env.js";
import { openDb, getState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { seedBook, settledCash, totalCash } from "./v2/settled-cash.js";
import { loadConfig } from "./v2/config.js";
import { alpacaReadPort } from "./v2/broker.js";
import { getMode } from "./mode.js";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const cfg = loadConfig();
const seedUsd = String(cfg.config.book.equityUsd); // 5000 — the design seed

const account = await alpacaReadPort.getAccount();
const brokerCash = d9(String(account.cash ?? "0"));
console.log(`[launch-init] account ${String(account.account_number ?? "?").slice(0, 4)}… status=${account.status} cash=${d9str(brokerCash)}`);

if (brokerCash !== d9(seedUsd)) {
  console.error(`[launch-init] HALT: broker cash ${d9str(brokerCash)} ≠ design seed $${seedUsd}.`);
  console.error("  This must be the FRESH paper account at exactly the seed amount (runbook §0). Not seeding.");
  process.exit(1);
}

const db = openDb();
const inserted = seedBook(db, seedUsd, today);
console.log(inserted
  ? `[launch-init] settled-cash ledger seeded: $${seedUsd} @ ${today}`
  : "[launch-init] ledger already seeded (idempotent no-op)");
console.log(`[launch-init] internal cash: total ${d9str(totalCash(db))} · settled(${today}) ${d9str(settledCash(db, today))}`);
console.log(`[launch-init] config ${cfg.version} · mode=${getMode()} · judgment=${getState(db, "judg:mode") ?? "protocol"}`);
if (getMode() !== "auto") console.log("[launch-init] NOTE: mode is not 'auto' — full-auto launch needs `npm run mode auto` (CJ's call).");
console.log("[launch-init] done. Next (runbook §3): install-v2.sh + enable the bill2-* timers on launch day.");
