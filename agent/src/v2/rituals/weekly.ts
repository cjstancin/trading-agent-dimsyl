// Bull v2 — WEEKLY ritual (Sunday ~18:00 ET). No market, no orders — evaluation + composition:
//   watchlist stabilization check → judgment kill-switches → momentum month-end signal run (if a
//   month closed since the last run; EXECUTION happens next trading morning) → anchor drift-watch
//   + amendment watch (inside the window) → Sunday digest → "Bill explains" (brief-tier LLM).
import type { DatabaseSync } from "node:sqlite";
import { d9str, type D9 } from "../decimal.js";
import { getState, setState } from "../db.js";
import { SLEEVES, SLEEVE_NAMES } from "../types.js";
import { ensureWatchlistTables, weeklyWatchlistCheck } from "../book/watchlist.js";
import { evaluateKillSwitches } from "../judgment/counterfactual.js";
import type { LlmPort } from "../judgment/llm-port.js";
import { sundayDigest, type DigestExtras } from "../surfaces/digest.js";
import { buildExplainsData, buildExplainsPrompt } from "../surfaces/explains.js";
import { escalationNote } from "../surfaces/notes.js";
import { ledgerPositions } from "../lots.js";
import { runMonthEnd, type MomPorts } from "../sleeves/momentum/month-end.js";
import { ensureMomTables } from "../sleeves/momentum/schema.js";
import type { MomentumConfig } from "../sleeves/momentum/ports.js";
import { runDriftWatch, watchAmendments, inAmendmentWindow, type AnchorPorts } from "../sleeves/anchor/index.js";
import { prevMonthKey, latestQuarterEnd } from "./time.js";
import { MOM_EXECUTED_MONTH_KEY } from "./morning.js";
import { readCorpPlan } from "./corp-actions.js";
import { pendingEntrySignals } from "./insider-signals.js";
import {
  step, priceMap9, sleeveEquityFor9, sleeveNavFor9,
  type CoreDeps, type StepResult,
} from "./support.js";
import { d9num } from "../decimal.js";

export const MOM_SIGNAL_MONTH_KEY = "mom:signal-month";

export interface WeeklyDeps extends CoreDeps {
  llm: LlmPort;
  momPorts: MomPorts | null;      // null → month-end signal run skipped with a note
  ancPorts: AnchorPorts | null;   // null → drift/amendment watch skipped with a note
}

export interface WeeklyResult {
  ok: boolean;
  skipped?: string;
  steps: StepResult[];
}

export async function runWeeklyRitual(deps: WeeklyDeps): Promise<WeeklyResult> {
  const { db, eff, today, post, latestPrice } = deps;
  const cfg = eff.config;
  const steps: StepResult[] = [];
  if (deps.mode === "off") return { ok: true, skipped: "mode=off", steps };

  // ---- 1 · watchlist stabilization check. ------------------------------------------------------
  await step(steps, post, "watchlist", async () => {
    ensureWatchlistTables(db);
    const symbols = (db.prepare("SELECT DISTINCT symbol FROM wl_exits WHERE status='active'").all() as { symbol: string }[])
      .map((r) => r.symbol);
    const prices = await priceMap9(symbols, latestPrice);
    const res = weeklyWatchlistCheck(db, {
      asOfDate: today, prices,
      stabilizationWeeks: Number(cfg.book.watchlist.stabilizationWeeks),
      pruneWeeks: Number(cfg.book.watchlist.pruneWeeks),
    });
    for (const f of res.newlyFlagged) {
      await post(`🔁 [${f.sleeve}] ${f.symbol} stabilized ${f.weeksAbove}w above its exit (${f.exitPrice9}) — flagged back into the sleeve's normal entry path (a flag, never an order).`);
    }
    return `checked ${res.checked}, flagged ${res.newlyFlagged.length}, pruned ${res.pruned}`;
  });

  // ---- 2 · judgment kill-switches (pre-registered, never config-tuned). ------------------------
  await step(steps, post, "kill-switches", async () => {
    const prices = await priceMap9(ledgerPositions(db).keys(), latestPrice);
    const sleeveNav9: Record<string, D9> = {};
    for (const s of SLEEVES) sleeveNav9[s] = sleeveNavFor9(db, eff, s, prices);
    const flags = evaluateKillSwitches(db, { asOfDate: today, sleeveNav9 });
    for (const f of flags) {
      const kind = f.kind === "revert-mechanical" ? "jdg-kill-switch" : "jdg-rubric-fix";
      db.prepare("INSERT INTO approvals(ts, kind, title, payload, status) VALUES(?,?,?,?,'pending')")
        .run(new Date().toISOString(), kind, f.reason, JSON.stringify(f));
      await post(escalationNote({
        kind,
        title: f.kind === "revert-mechanical"
          ? `judgment layer reverted to MECHANICAL stops — ${f.reason}`
          : `judge-panel disagreement — rubric needs work: ${f.reason}`,
      }));
    }
    return `${flags.length} flag(s)${getState(db, "judg:mode") === "mechanical" ? " · mode=mechanical" : ""}`;
  });

  // ---- 3 · momentum month-end signal run (execution waits for the next trading morning). -------
  await step(steps, post, "momentum-month-end", async () => {
    const target = prevMonthKey(today);
    if (getState(db, MOM_SIGNAL_MONTH_KEY) === target) return `month ${target} already ranked`;
    if (!deps.momPorts) {
      await post(`⚠️ [Momentum] month-end ${target} due but no data ports wired — signal run skipped (supervisor seam).`);
      return "no ports";
    }
    const res = await runMonthEnd(db, deps.momPorts, cfg.momentum as MomentumConfig, target, d9num(sleeveEquityFor9(db, eff, "mom")));
    setState(db, MOM_SIGNAL_MONTH_KEY, target);
    await post(`📈 [Momentum] month-end ${target}: universe ${res.universeCount}, top ${res.ranks.top.length}, survivors ${res.ranks.final.length}, vetoed ${res.ranks.vetoed.length} — orders queue for the first trading morning.`);
    return `ranked ${target} (${res.ranks.final.length} survivors)`;
  });

  // ---- 4 · anchor drift-watch + amendment watch. -----------------------------------------------
  await step(steps, post, "anchor-watch", async () => {
    if (!deps.ancPorts) {
      await post(`⚠️ [Anchor] drift/amendment watch skipped — no EDGAR/mapping/price ports wired (supervisor seam).`);
      return "no ports";
    }
    const period = latestQuarterEnd(today);
    const hits = await runDriftWatch(db, deps.ancPorts, eff, period);
    for (const h of hits) {
      await post(escalationNote({ kind: `anchor-drift:${h.detector}`, title: `[${h.level}] ${h.manager} ${h.detector} (${h.period})` }));
    }
    let amendNote = "outside amendment window";
    if (inAmendmentWindow(period, today, eff)) {
      const wa = await watchAmendments(db, deps.ancPorts, eff, { period, today });
      amendNote = `amendments: ${wa.newFilings} new filing(s)${wa.retrade ? " → RETRADE gated for next open" : ""}`;
      if (wa.newFilings) await post(`🏛️ [Anchor] ${amendNote}`);
    }
    return `drift hits ${hits.length} · ${amendNote}`;
  });

  // ---- 5 · Sunday digest. ----------------------------------------------------------------------
  await step(steps, post, "digest", async () => {
    const dialRaw = getState(db, "dial:lei");
    const dialParsed = dialRaw ? (JSON.parse(dialRaw) as { position: string; asOf: string }) : null;
    const dialLine = dialParsed ? `${dialParsed.position} (as of ${dialParsed.asOf})` : "not yet resolved";
    const tier = getState(db, "brake:tier") ?? "0";
    const peak = getState(db, "brake:peak9");
    const brakeLine = `tier ${tier}${peak ? ` · peak ${d9str(BigInt(peak))}` : ""}`;

    const mondayQueue: string[] = [];
    if (getState(db, "anc:pending_rebuild")) mondayQueue.push("Anchor: gated rebuild pending → trades next open");
    ensureMomTables(db);
    const momMonth = (db.prepare("SELECT MAX(month) AS m FROM mom_ranks").get() as { m: string | null } | undefined)?.m;
    const momDone = getState(db, MOM_EXECUTED_MONTH_KEY);
    if (momMonth && (!momDone || momDone < momMonth)) mondayQueue.push(`Momentum: ${momMonth} rebalance pending (first-trading-day execution)`);
    const pendIns = pendingEntrySignals(db);
    if (pendIns.length) mondayQueue.push(`Insider: ${pendIns.length} signal(s) → entry next open (${pendIns.map((p) => p.cluster.symbol).join(", ")})`);
    const corp = readCorpPlan(db);
    if (corp?.exitBefore.length) mondayQueue.push(`Corporate actions: ${corp.exitBefore.length} exit-before sale(s) queued`);
    mondayQueue.push(`${SLEEVE_NAMES.wld}: weekly pick run (Monday)`);

    const extras: DigestExtras = { dialLine, brakeLine, mondayQueue };
    await post(sundayDigest(db, { asOfDate: today, extras }));
    return "posted";
  });

  // ---- 6 · "Bill explains" (brief-tier, stateless; narrates facts, invents nothing). -----------
  await step(steps, post, "bill-explains", async () => {
    const data = buildExplainsData(db, today);
    const dialRaw = getState(db, "dial:lei");
    data.dialLine = dialRaw ? (JSON.parse(dialRaw) as { position: string }).position : null;
    const text = (await deps.llm.complete("brief", buildExplainsPrompt(data))).trim();
    if (!text) throw new Error("empty Bill-explains reply — brief call failed");
    await post(`🐂 **Bill explains — week ending ${today}**\n${text}`);
    return "posted";
  });

  return { ok: steps.every((s) => s.ok), steps };
}
