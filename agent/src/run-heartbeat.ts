// Bull market-hours "monitoring" heartbeat → SAMS. The open/mid/close trade fires are brief; this keeps
// Bill present + MONITORING throughout the session (bill-heartbeat.timer, ~every 5 min during market hours),
// so the Port shows him ONLINE + monitoring instead of offline between fires. Pulls the live Alpaca PAPER
// snapshot and pushes a status patch to SAMS. LLM-free; the only order it can ever place is the protective
// SYNTHETIC-STOP sell below (auto mode + exec opt-in + regular session hours only).
//   npm run heartbeat
import "./load-env.js";
import { paperSnapshot } from "./alpaca.js";
import { samsReport } from "./sams-report.js";
import { isWeekendET, isKnownNyseHoliday, isMarketDayToday, isDuringSessionET } from "./market-calendar.js";
import { installSafetyNet } from "./http-utils.js";
import { getMode, autoExecAllowed } from "./mode.js";
import { getProfile } from "./profile.js";
import { rulesFor } from "./guardrails.js";
import { runSyntheticStops } from "./synthetic-stops.js";

installSafetyNet("bill-heartbeat");

const num = (v: unknown): number => {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};

// Stay quiet on non-trading days so Bill correctly shows OFFLINE outside sessions. The systemd timer only
// fires Mon-Fri market hours; this also guards holidays the timer can't know about.
if (isWeekendET() || isKnownNyseHoliday()) {
  console.error("bill-heartbeat: not a trading day — no beat.");
  process.exit(0);
}

const snap = await paperSnapshot();
if (!snap.connected) {
  await samsReport("bull", {
    status: "warn", room: "bull", roomTitle: "Port", loadScore: 0,
    event: { type: "monitoring", level: "warn", text: "Monitoring the Port — Alpaca paper not reachable" },
  });
  console.error("bill-heartbeat: alpaca not connected — warn beat.");
  process.exit(0);
}

const acct = (snap.account ?? {}) as Record<string, unknown>;
const equity = num(acct.equity ?? acct.portfolio_value);
const rawPositions = (Array.isArray(snap.positions) ? snap.positions : []) as Record<string, unknown>[];
const positions = rawPositions.length;

// Synthetic trailing-stop sweep (INTRADAY): every buy is fractional, so there's no broker stop — and the
// refresh ritual's sweep only fires at its once-a-day 16:00 run, leaving positions unprotected all session.
// The heartbeat already snapshots positions every 5 min, so run the same deterministic sweep here, gated to
// regular session hours AND the mode/env gate (a stop is an order → auto mode + BILL_ALLOW_AUTO_EXEC only).
// No double-fire vs refresh: this only runs BEFORE the close (isDuringSessionET), the refresh sweep runs at
// 16:00 after it; and a breach sold here disappears from the next snapshot + is pruned from stops.json.
try {
  if (rawPositions.length && getMode() === "auto" && autoExecAllowed()) {
    const day = await isMarketDayToday();
    if (day.open && isDuringSessionET(day.halfDay)) {
      const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);
      const rules = rulesFor(getProfile());
      const res = await runSyntheticStops({
        rawPositions,
        trailPct: rules.trailPercent ?? 20,
        mode: "auto",
        marketOpen: true,
        alert: (msg) => sendDiscord(msg, { channel: "bull", username: "Bill the Bull" }),
      });
      if (res.breaches.length) console.error(`bill-heartbeat: synthetic stops — ${res.breaches.length} breach(es), sold: ${res.sold.join(", ") || "none"}`);
    }
  }
} catch (e) { console.error("bill-heartbeat: synthetic-stop sweep failed:", String(e instanceof Error ? e.message : e)); }

await samsReport("bull", {
  status: "ok", room: "bull", roomTitle: "Port", loadScore: 0,
  metrics: { equity, positions },
  event: { type: "monitoring", text: `Monitoring the Port — eq $${Math.round(equity).toLocaleString("en-US")} · ${positions} position(s)` },
});
console.error(`bill-heartbeat: beat ok — eq ${equity} · ${positions} pos`);
process.exit(0);
