// Bull v2 — STATEMENT ritual (1st of the month ~08:00 ET). Compose the previous month's plain-
// English statement from the ledger and post it. Pure composition — no orders, no market gate.
import { monthlyStatement } from "../surfaces/statement.js";
import { prevMonthKey } from "./time.js";
import { step, type CoreDeps, type StepResult } from "./support.js";

export interface StatementResult {
  ok: boolean;
  skipped?: string;
  month: string;
  steps: StepResult[];
}

export async function runStatementRitual(deps: CoreDeps): Promise<StatementResult> {
  const { db, today, post } = deps;
  const month = prevMonthKey(today);
  const steps: StepResult[] = [];
  if (deps.mode === "off") return { ok: true, skipped: "mode=off", month, steps };

  await step(steps, post, "monthly-statement", async () => {
    await post(monthlyStatement(db, month));
    return `posted ${month}`;
  });

  return { ok: steps.every((s) => s.ok), month, steps };
}
