// Bull v2 — MONTHLY STATEMENT entry (systemd: 1st of month ~08:00 ET). Composes and posts the
// previous month's statement. Run: `npx tsx src/run-v2-statement.ts`.
import "./load-env.js";
import { installSafetyNet } from "./http-utils.js";
import { runStatementRitual } from "./v2/rituals/statement.js";
import { realStatementDeps } from "./v2/rituals/real-deps.js";

installSafetyNet("bull-v2-statement");

const res = await runStatementRitual(realStatementDeps());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exitCode = 1;
