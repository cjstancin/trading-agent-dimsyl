// Bull v2 — EVENING entry (systemd: Mon–Fri ~16:30 ET). Thin wrapper: env → real deps → ritual.
// All orchestration lives in v2/rituals/evening.ts; run: `npx tsx src/run-v2-evening.ts`.
import "./load-env.js";
import { installSafetyNet } from "./http-utils.js";
import { runEveningRitual } from "./v2/rituals/evening.js";
import { realEveningDeps } from "./v2/rituals/real-deps.js";

installSafetyNet("bull-v2-evening");

const res = await runEveningRitual(realEveningDeps());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exitCode = 1;
