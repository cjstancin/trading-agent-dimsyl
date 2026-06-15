// Risk alerts (Bull v2 #7) — deterministic threshold checks against the active profile's halts. Returns
// alert lines; the refresh ritual posts any to Discord #trade-bot, making the channel a real-time risk co-pilot.
import { rulesFor } from "./guardrails.js";
import { getProfile } from "./profile.js";

export interface AlertCtx { dayPnlPct: number; monthPnlPct: number; drawdown: number; largestPos: number; }

export function computeAlerts(c: AlertCtx): string[] {
  const r = rulesFor(getProfile());
  const dailyHalt = -(r.dailyHaltPct ?? 10);
  const monthlyKill = -(r.monthlyKillPct ?? 30);
  const posCap = (r.maxPositionPct ?? 0.4) * 100;
  const out: string[] = [];
  if (c.dayPnlPct <= dailyHalt) out.push(`🛑 Daily-loss HALT hit (${c.dayPnlPct}% ≤ ${dailyHalt}%) — no new entries today.`);
  else if (c.dayPnlPct <= dailyHalt * 0.5) out.push(`⚠️ Nearing daily-loss halt (${c.dayPnlPct}% of ${dailyHalt}%).`);
  if (c.monthPnlPct <= monthlyKill) out.push(`☠️ Monthly KILL-SWITCH armed (${c.monthPnlPct}% ≤ ${monthlyKill}%) — stand down for the month.`);
  if (c.drawdown <= -15) out.push(`📉 Drawdown ${c.drawdown}% from peak equity.`);
  if (c.largestPos > posCap) out.push(`⚖️ Largest position ${c.largestPos}% exceeds the ${posCap}% cap.`);
  return out;
}
