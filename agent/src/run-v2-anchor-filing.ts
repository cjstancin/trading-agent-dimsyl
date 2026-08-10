// Bull v2 — ANCHOR FILING entry (systemd: Feb/May/Aug/Nov ~14th 20:00 ET + daily amendment-watch
// ticks; the ritual is idempotent, so extra fires re-fetch nothing already stored).
// Run: `npx tsx src/run-v2-anchor-filing.ts`.
import "./load-env.js";
import { installSafetyNet } from "./http-utils.js";
import { runAnchorFilingRitual } from "./v2/rituals/anchor-filing.js";
import { realAnchorFilingDeps } from "./v2/rituals/real-deps.js";

installSafetyNet("bull-v2-anchor-filing");

const res = await runAnchorFilingRitual(realAnchorFilingDeps());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exitCode = 1;
