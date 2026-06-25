// Risk alerts (Bull v2 #7) — deterministic threshold checks against the active profile's halts. Returns
// alert lines; the refresh ritual posts any to Discord #trade-bot, making the channel a real-time risk co-pilot.
import { rulesFor } from "./guardrails.js";
import { getProfile } from "./profile.js";

export interface AlertCtx { dayPnlPct: number; monthPnlPct: number; drawdown: number; largestPos: number; }
/** A risk alert + a stable `key` for its TYPE (not its live numbers), so the refresh ritual can de-dup
 *  against the previous cycle — a persistent condition pings Discord ONCE, not every 5-min refresh. */
export interface Alert { key: string; text: string; }

export function computeAlerts(c: AlertCtx): Alert[] {
  const r = rulesFor(getProfile());
  const dailyHalt = -(r.dailyHaltPct ?? 10);
  const monthlyKill = -(r.monthlyKillPct ?? 30);
  const posCap = (r.maxPositionPct ?? 0.4) * 100;
  // The position cap is an ENTRY limit (enforced in guardrails at order time). A held position drifting
  // past it because it APPRECIATED is normal — Bill's rule is "let winners run" — so that is NOT alarm-worthy
  // (it's just one name having a good day while another lags). Only flag genuine single-name DOMINANCE:
  // ≥2× the entry cap (floored at 40%), i.e. one name is twice what we'd ever deliberately size into.
  // Per-key de-dup in the refresh ritual then keeps even that to a single heads-up.
  const concentrationFloor = Math.max(Math.round(posCap * 2), 40);
  const out: Alert[] = [];
  if (c.dayPnlPct <= dailyHalt) out.push({ key: "daily-halt", text: `🛑 Daily-loss HALT hit (${c.dayPnlPct}% ≤ ${dailyHalt}%) — no new entries today.` });
  else if (c.dayPnlPct <= dailyHalt * 0.5) out.push({ key: "daily-near", text: `⚠️ Nearing daily-loss halt (${c.dayPnlPct}% of ${dailyHalt}%).` });
  if (c.monthPnlPct <= monthlyKill) out.push({ key: "monthly-kill", text: `☠️ Monthly KILL-SWITCH armed (${c.monthPnlPct}% ≤ ${monthlyKill}%) — stand down for the month.` });
  if (c.drawdown <= -15) out.push({ key: "drawdown", text: `📉 Drawdown ${c.drawdown}% from peak equity.` });
  if (c.largestPos >= concentrationFloor) out.push({ key: "concentration", text: `⚖️ Single-name concentration: largest position is ${c.largestPos}% of the book (≥${concentrationFloor}%).` });
  return out;
}
