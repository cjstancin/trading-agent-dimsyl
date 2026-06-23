// Bull market-hours "monitoring" heartbeat → SAMS. The open/mid/close trade fires are brief; this keeps
// Bill present + MONITORING throughout the session (bill-heartbeat.timer, ~every 5 min during market hours),
// so the Port shows him ONLINE + monitoring instead of offline between fires. Read-only: pulls the live
// Alpaca PAPER snapshot and pushes a status patch to SAMS. NEVER places an order.
//   npm run heartbeat
import "./load-env.js";
import { paperSnapshot } from "./alpaca.js";
import { samsReport } from "./sams-report.js";
import { isWeekendET, isKnownNyseHoliday } from "./market-calendar.js";
import { installSafetyNet } from "./http-utils.js";

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
const positions = Array.isArray(snap.positions) ? snap.positions.length : 0;
await samsReport("bull", {
  status: "ok", room: "bull", roomTitle: "Port", loadScore: 0,
  metrics: { equity, positions },
  event: { type: "monitoring", text: `Monitoring the Port — eq $${Math.round(equity).toLocaleString("en-US")} · ${positions} position(s)` },
});
console.error(`bill-heartbeat: beat ok — eq ${equity} · ${positions} pos`);
process.exit(0);
