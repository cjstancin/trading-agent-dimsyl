// Bull v2 — MORNING entry (systemd: Mon–Fri ~09:35 ET). Thin wrapper: env → real deps → ritual.
// All orchestration lives in v2/rituals/morning.ts; run: `npx tsx src/run-v2-morning.ts`.
import "./load-env.js";
import { installSafetyNet } from "./http-utils.js";
import { runMorningRitual } from "./v2/rituals/morning.js";
import { realMorningDeps } from "./v2/rituals/real-deps.js";

installSafetyNet("bull-v2-morning");

const res = await runMorningRitual(realMorningDeps());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exitCode = 1;
