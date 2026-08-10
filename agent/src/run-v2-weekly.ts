// Bull v2 — WEEKLY entry (systemd: Sunday ~18:00 ET). Thin wrapper: env → real deps → ritual.
// All orchestration lives in v2/rituals/weekly.ts; run: `npx tsx src/run-v2-weekly.ts`.
import "./load-env.js";
import { installSafetyNet } from "./http-utils.js";
import { runWeeklyRitual } from "./v2/rituals/weekly.js";
import { realWeeklyDeps } from "./v2/rituals/real-deps.js";

installSafetyNet("bull-v2-weekly");

const res = await runWeeklyRitual(realWeeklyDeps());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exitCode = 1;
