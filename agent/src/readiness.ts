// Paper→live readiness gate (Bull v2 #8): a deterministic checklist that must ALL pass before going live
// is even proposed. Keeps the "never live without proof" rail structural. Pure function over Measurement.
import type { Measurement } from "./stats.js";

export interface ReadinessCheck { label: string; pass: boolean; detail: string; }
export interface Readiness { ready: boolean; passed: number; total: number; checks: ReadinessCheck[] }

const MIN_TRADES = 30, MIN_PF = 1.3, MAX_DD = 20;

export function readiness(m: Measurement): Readiness {
  const s = m.stats;
  const checks: ReadinessCheck[] = [
    { label: `≥ ${MIN_TRADES} closed trades`, pass: s.trades >= MIN_TRADES, detail: `${s.trades} closed` },
    { label: "Positive expectancy", pass: s.expectancy > 0, detail: `$${s.expectancy}/trade` },
    { label: `Profit factor ≥ ${MIN_PF}`, pass: s.profitFactor >= MIN_PF, detail: `${s.profitFactor}` },
    { label: `Max drawdown < ${MAX_DD}%`, pass: Math.abs(m.risk.maxDD) < MAX_DD, detail: `${m.risk.maxDD}%` },
    { label: "Beats S&P over window", pass: m.vsSpyPct > 0, detail: `${m.vsSpyPct >= 0 ? "+" : ""}${m.vsSpyPct}% vs SPY` },
  ];
  const passed = checks.filter((c) => c.pass).length;
  return { ready: passed === checks.length, passed, total: checks.length, checks };
}
