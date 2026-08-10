// Bull v2 — INSIDER POLL entry (systemd: every 2–5 min, 06:00–22:05 ET weekdays; the ritual's
// shouldPollNow gate makes off-window fires a silent no-op). One Atom pass per invocation.
// Run: `npx tsx src/run-v2-insider-poll.ts`.
import "./load-env.js";
import { installSafetyNet } from "./http-utils.js";
import { runInsiderPollRitual } from "./v2/rituals/insider-poll.js";
import { realInsiderPollDeps } from "./v2/rituals/real-deps.js";

installSafetyNet("bull-v2-insider-poll");

const res = await runInsiderPollRitual(realInsiderPollDeps());
console.log(JSON.stringify(res, null, 2));
if (!res.ok) process.exitCode = 1;
