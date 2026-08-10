// Bull v2 — ANCHOR FILING ritual (Feb/May/Aug/Nov ~14th 20:00 ET, plus the daily amendment-watch
// ticks inside each ~60-day window). Fetch/store/rebuild/gate happens tonight; TRADING never does —
// runFilingEvening leaves the gated anc:pending_rebuild marker and the next MORNING ritual trades
// it. A failure here escalates loudly (a silently-missed 13F evening would corrupt the quarter).
import { runFilingEvening, watchAmendments, inAmendmentWindow, type AnchorPorts } from "../sleeves/anchor/index.js";
import { escalationNote } from "../surfaces/notes.js";
import { latestQuarterEnd } from "./time.js";
import { type CoreDeps, type StepResult } from "./support.js";

export interface AnchorFilingDeps extends CoreDeps {
  ancPorts: AnchorPorts;
}

export interface AnchorFilingResult {
  ok: boolean;
  skipped?: string;
  period: string;
  newFilings: number;
  retrade: boolean;
  steps: StepResult[];
}

export async function runAnchorFilingRitual(deps: AnchorFilingDeps): Promise<AnchorFilingResult> {
  const { db, eff, today, post } = deps;
  const period = latestQuarterEnd(today);
  const steps: StepResult[] = [];
  const out: AnchorFilingResult = { ok: true, period, newFilings: 0, retrade: false, steps };
  if (deps.mode === "off") return { ...out, skipped: "mode=off" };

  // Filing evening — custom catch: the brief's contract is failures → escalationNote, not a warn.
  try {
    const res = await runFilingEvening(db, deps.ancPorts, eff, { period, today });
    out.newFilings = res.newFilings.length;
    out.retrade = res.retrade;
    for (const f of res.newFilings) {
      await post(`🏛️ [Anchor] 13F stored: ${f.manager} (${f.accession})${f.restated ? " — RESTATEMENT, quarter re-scored" : ""}`);
    }
    for (const m of res.missing) {
      await post(`⏳ [Anchor] ${m.manager} has not filed for ${period} (${m.daysLate} day(s) past deadline) — liveness detector watching.`);
    }
    if (res.mappingFlags) {
      await post(escalationNote({
        kind: "anchor-mapping",
        title: `${res.mappingFlags} unmapped CUSIP(s) in the ${period} clone — flagged to approvals, never guessed`,
      }));
    }
    if (res.retrade) {
      await post(`🏛️ [Anchor] rebuild gated (${res.retradeReason}) — trades at the NEXT MARKET OPEN via the morning ritual.`);
    }
    if (res.driftHits.length) {
      await post(`👁️ [Anchor] drift-watch: ${res.driftHits.length} hit(s) filed to the approvals queue.`);
    }
    steps.push({ name: "filing-evening", ok: true, detail: `filings +${out.newFilings}, retrade ${out.retrade}` });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    steps.push({ name: "filing-evening", ok: false, detail: msg });
    try {
      await post(escalationNote({
        kind: "anchor-filing-failure",
        title: `13F filing-evening run FAILED for ${period}`,
        detail: msg,
      }));
    } catch { /* Discord never breaks a ritual */ }
  }

  // Amendment watch (idempotent; only inside the ~60-day window).
  if (inAmendmentWindow(period, today, eff)) {
    try {
      const wa = await watchAmendments(db, deps.ancPorts, eff, { period, today });
      if (wa.newFilings) {
        await post(`🏛️ [Anchor] amendment watch: ${wa.newFilings} new filing(s) for ${period}${wa.retrade ? " → RETRADE gated for next open" : " (gate unchanged)"}`);
      }
      steps.push({ name: "amendment-watch", ok: true, detail: `+${wa.newFilings}${wa.retrade ? " retrade" : ""}` });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      steps.push({ name: "amendment-watch", ok: false, detail: msg });
      try {
        await post(escalationNote({ kind: "anchor-filing-failure", title: `amendment watch FAILED for ${period}`, detail: msg }));
      } catch { /* ignore */ }
    }
  } else {
    steps.push({ name: "amendment-watch", ok: true, detail: "outside window" });
  }

  out.ok = steps.every((s) => s.ok);
  return out;
}
