// Bull v2 — Anchor: annual bench refresh (design final decision #2). Once a year the selection
// criteria that picked the four locked managers get RE-RUN over (a) provided candidate summaries
// and (b) the incumbents' drift health — and the output is a REPORT into CJ's approval queue.
// Nothing here swaps a manager; the report exists so the annual decision is made from evidence on
// one page instead of vibes. The manager set stays CJ-LOCKED until CJ edits config.
//
// Selection criteria (design, verbatim): top-10 >50% of 13F value · holding period >1yr ·
// >10yr credible record · clean (no regulatory taint) · 13F representative of the real book ·
// top holdings US-listed. Structural criteria are checked from data when a summary is provided;
// judgment criteria (record, clean) come in as researched inputs — the generator scores, CJ decides.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9num, type D9 } from "../../decimal.js";
import type { FilingSummary, DriftHit, ManagerCfg } from "./types.js";
import { queueApproval } from "./store.js";

export type CriterionVerdict = "pass" | "fail" | "unknown";

export interface BenchCandidateInput {
  name: string;
  cik: string;
  /** Latest 13F summary when available — drives the top-10 concentration + representativeness checks. */
  summary?: FilingSummary;
  /** Researched inputs (from the annual research pass; unknown = not yet researched). */
  medianHoldingYears?: number;
  recordYears?: number;
  clean?: boolean;
  topHoldingsUsListed?: boolean;
  notes?: string;
}

export interface IncumbentInput {
  manager: ManagerCfg;
  summary?: FilingSummary;
  driftHits: DriftHit[];   // accumulated hits since the last bench refresh
}

export interface CandidateScore {
  name: string;
  cik: string;
  criteria: Record<string, CriterionVerdict>;
  passes: number;
  unknowns: number;
  eligible: boolean;       // all six criteria pass (unknowns block eligibility — research them first)
  notes?: string;
}

export interface IncumbentScore {
  manager: string;
  cik: string;
  note?: string;
  warnCount: number;
  ejectCount: number;
  detectorsTripped: string[];
  top10Share: number | null;
  status: "healthy" | "watch" | "review";
}

export interface BenchReport {
  kind: "anchor-bench";
  asOf: string;
  incumbents: IncumbentScore[];
  candidates: CandidateScore[];
  recommendation: "no-action" | "review-incumbents";
  summary: string;
}

const TOP10_MIN = 0.5; // structural criterion mirrors driftWatch's top10ShareMin design number
const NON_EQUITY_REPRESENTATIVE_MAX = 0.1;

function verdict(cond: boolean | undefined): CriterionVerdict {
  return cond === undefined ? "unknown" : cond ? "pass" : "fail";
}

export function scoreCandidate(c: BenchCandidateInput): CandidateScore {
  const criteria: Record<string, CriterionVerdict> = {
    "top10-over-50pct": c.summary ? verdict(c.summary.top10Share9 > d9(TOP10_MIN)) : "unknown",
    "holding-period-over-1yr": verdict(c.medianHoldingYears === undefined ? undefined : c.medianHoldingYears > 1),
    "record-over-10yr": verdict(c.recordYears === undefined ? undefined : c.recordYears > 10),
    "clean": verdict(c.clean),
    "13f-representative": c.summary ? verdict(c.summary.nonEquityShare9 <= d9(NON_EQUITY_REPRESENTATIVE_MAX)) : "unknown",
    "us-listed": verdict(c.topHoldingsUsListed),
  };
  const vals = Object.values(criteria);
  const passes = vals.filter((v) => v === "pass").length;
  const unknowns = vals.filter((v) => v === "unknown").length;
  return {
    name: c.name, cik: c.cik, criteria, passes, unknowns,
    eligible: passes === vals.length,
    ...(c.notes ? { notes: c.notes } : {}),
  };
}

export function scoreIncumbent(inc: IncumbentInput): IncumbentScore {
  const warns = inc.driftHits.filter((h) => h.level === "warn");
  const ejects = inc.driftHits.filter((h) => h.level === "eject");
  return {
    manager: inc.manager.name,
    cik: inc.manager.cik,
    ...(inc.manager.note ? { note: inc.manager.note } : {}),
    warnCount: warns.length,
    ejectCount: ejects.length,
    detectorsTripped: [...new Set(inc.driftHits.map((h) => h.detector))],
    top10Share: inc.summary ? d9num(inc.summary.top10Share9) : null,
    status: ejects.length > 0 ? "review" : warns.length > 0 ? "watch" : "healthy",
  };
}

/** Build the annual report. Pure — queueBenchReport persists it. */
export function benchReport(opts: {
  asOf: string;
  incumbents: IncumbentInput[];
  candidates: BenchCandidateInput[];
}): BenchReport {
  const incumbents = opts.incumbents.map(scoreIncumbent);
  const candidates = opts.candidates.map(scoreCandidate)
    .sort((a, b) => (a.passes === b.passes ? a.unknowns - b.unknowns : b.passes - a.passes));
  const needsReview = incumbents.some((i) => i.status === "review");
  const eligibleCount = candidates.filter((c) => c.eligible).length;
  return {
    kind: "anchor-bench",
    asOf: opts.asOf,
    incumbents,
    candidates,
    recommendation: needsReview ? "review-incumbents" : "no-action",
    summary:
      `${incumbents.filter((i) => i.status === "healthy").length}/${incumbents.length} incumbents healthy` +
      (needsReview ? ` — ${incumbents.filter((i) => i.status === "review").map((i) => i.manager).join(", ")} carrying eject flags` : "") +
      `; ${eligibleCount}/${candidates.length} candidates fully eligible. Manager set stays locked until CJ acts.`,
  };
}

/** Persist the report to the approvals queue (kind 'anchor-bench'). CJ reads, CJ decides. */
export function queueBenchReport(db: DatabaseSync, report: BenchReport): number {
  return queueApproval(db, "anchor-bench", `[anchor] annual bench refresh ${report.asOf}: ${report.recommendation}`, report);
}
