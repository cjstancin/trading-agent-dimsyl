// Bull v2 — thesis-check protocol (design §6, CJ-locked "2, as long as it works"). A stop firing
// on Insider/Wildcard is CLASSIFICATION, not advice — the structure that kills the documented LLM
// hold-a-loser disposition bias:
//   Pass 1  risk-officer brief: strongest impairment case + what disconfirming evidence would look like
//   Pass 2  independent intact-thesis brief (never sees Pass 1)
//   Pass 3  judge sees ONLY the two structured briefs → class + probability + citations, ×3 votes
// Any single thesis_break vote escalates (asymmetric — a missed bankruptcy costs more than a
// premature stop). Class→action lives in CODE: break → sell now (2-source corroborated, else CJ);
// impairment/noise → hold with the hard −25%-from-entry floor code enforces regardless of ANY
// model output. Calls are stateless; evidence arrives pre-quarantined as Claim rows.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, type D9 } from "./../decimal.js";
import { getState } from "./../db.js";
import type { Claim } from "./quarantine.js";
import { distinctSources, inputHash } from "./quarantine.js";
import { parseJsonReply, type LlmPort } from "./llm-port.js";
import { recordVerdict, JDG_MODE_KEY } from "./counterfactual.js";

/** The floor is a NON-TUNABLE (config refuses thesisCheck.hardFloorPct amendments); this constant is
 *  the defense-in-depth copy at the use site. −25% from entry. */
export const HARD_FLOOR_FRACTION = "0.75";

export type ThesisClass = "thesis_break" | "partial_impairment" | "market_noise";
export interface JudgeVote { class: ThesisClass; probability: "low" | "medium" | "high"; citations: number[]; }

export interface ThesisCheckInput {
  sleeve: "ins" | "wld";
  symbol: string;
  entryPrice9: D9;
  currentPrice9: D9;
  stopPrice9: D9;
  qty9: D9;
  thesis: string;              // the position's ORIGINAL thesis (wildcard: + pre-written invalidation)
  invalidation?: string;
  claims: Claim[];             // pre-quarantined evidence rows
  asOfDate: string;
  configVersion: string;
  proxyPrice9: D9;             // sleeve proxy (IWM/SPY) at verdict time — counterfactual basis
}

export interface ThesisVerdict {
  action: "sell_now" | "hold_with_floor" | "escalate_hold" | "deferred";
  cls: ThesisClass | "mechanical" | "floor_enforced" | "llm_failure" | "halted";
  votes: JudgeVote[];
  escalated: boolean;          // needs an approvals row + Discord ping
  corroborated: boolean | null;
  floorPrice9: D9;
  hash: string;
  verdictId?: number;
  notes: string[];
}

interface BearBrief { impairment_case: string; disconfirming_evidence_needed: string; citations: number[]; severity: "low" | "medium" | "high"; }
interface BullBrief { intact_case: string; citations: number[]; confidence: "low" | "medium" | "high"; }

function claimsBlock(claims: Claim[]): string {
  return claims.map((c, i) => `[${i}] ${c.date} · ${c.source} · ${c.tickers.join(",")} · ${c.claim}${c.number != null ? ` (${c.number})` : ""}`).join("\n");
}

function positionBlock(inp: ThesisCheckInput): string {
  const drop = inp.entryPrice9 > 0n ? Number(((inp.entryPrice9 - inp.currentPrice9) * 10_000n) / inp.entryPrice9) / 100 : 0;
  return [
    `Position: ${inp.symbol} (${inp.sleeve === "ins" ? "insider-cluster sleeve" : "wildcard sleeve"})`,
    `Entry ${d9str(inp.entryPrice9)} · now ${d9str(inp.currentPrice9)} (${drop >= 0 ? "-" : "+"}${Math.abs(drop)}% from entry) · stop that fired: ${d9str(inp.stopPrice9)}`,
    `Original thesis: ${inp.thesis}`,
    ...(inp.invalidation ? [`Pre-written invalidation: ${inp.invalidation}`] : []),
  ].join("\n");
}

async function askJson<T>(llm: LlmPort, role: "brief" | "judge", prompt: string, validate: (v: unknown) => T | null, blocked: () => string | null): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (blocked()) return null;
    try {
      const reply = await llm.complete(role, prompt);
      if (blocked()) return null; // a halt during the call cancels this assessment, including retries
      const v = validate(parseJsonReply(reply));
      if (v) return v;
    } catch { /* retry once, then fail closed */ }
  }
  return null;
}

const vBear = (v: unknown): BearBrief | null => {
  const b = v as BearBrief;
  return b && typeof b.impairment_case === "string" && Array.isArray(b.citations) && ["low", "medium", "high"].includes(b.severity)
    ? { ...b, citations: b.citations.map(Number).filter(Number.isInteger) } : null;
};
const vBull = (v: unknown): BullBrief | null => {
  const b = v as BullBrief;
  return b && typeof b.intact_case === "string" && Array.isArray(b.citations) && ["low", "medium", "high"].includes(b.confidence)
    ? { ...b, citations: b.citations.map(Number).filter(Number.isInteger) } : null;
};
const vVote = (v: unknown): JudgeVote | null => {
  const j = v as JudgeVote;
  return j && ["thesis_break", "partial_impairment", "market_noise"].includes(j.class) && ["low", "medium", "high"].includes(j.probability)
    ? { class: j.class, probability: j.probability, citations: Array.isArray(j.citations) ? j.citations.map(Number).filter(Number.isInteger) : [] } : null;
};

/** Run the full protocol for one fired stop. A book/sleeve halt returns a non-actionable deferred
 *  result without a verdict or counterfactual row; the caller must keep the stop event pending.
 *  Every completed (unhalted) assessment is recorded. */
export async function runThesisCheck(db: DatabaseSync, llm: LlmPort, inp: ThesisCheckInput): Promise<ThesisVerdict> {
  const floor = mul9(inp.entryPrice9, d9(HARD_FLOOR_FRACTION));
  const hash = inputHash({ s: inp.symbol, e: d9str(inp.entryPrice9), c: d9str(inp.currentPrice9), t: inp.thesis, n: inp.claims.length, d: inp.asOfDate });
  const notes: string[] = [];
  let observedHalt: string | null = null;
  // Once observed, a halt cancels THIS assessment even if an operator clears it before we return.
  // The pending event can receive a fresh assessment in a later unhalted run.
  const blocked = (): string | null => observedHalt ??= (getState(db, "halt:book") || getState(db, `halt:${inp.sleeve}`) || null);
  const deferred = (): ThesisVerdict => ({
    action: "deferred", cls: "halted", votes: [], escalated: false, corroborated: null,
    floorPrice9: floor, hash, notes: [`assessment deferred by halt: ${observedHalt ?? "halt observed before verdict persistence"}`],
  });
  const log = (cls: string, action: string, votes: JudgeVote[], bearSeverity?: string): number | null => {
    // Keep the final halt read and durable write in one SQLite transaction. A concurrent writer
    // cannot commit a halt between this read and a successful verdict commit; contention fails
    // closed to the ritual's error boundary instead of recording a decision over a changed halt.
    db.exec("SAVEPOINT thesis_verdict");
    try {
      const id = blocked() ? null : recordVerdict(db, {
        ts: new Date().toISOString(), sleeve: inp.sleeve, symbol: inp.symbol, inputHash: hash,
        votesJson: JSON.stringify(votes), cls, action, entryPrice9: inp.entryPrice9, verdictPrice9: inp.currentPrice9,
        stopPrice9: inp.stopPrice9, qty9: inp.qty9, proxyPrice9: inp.proxyPrice9, bearSeverity, configVersion: inp.configVersion,
      });
      db.exec("RELEASE thesis_verdict");
      return id;
    } catch (e) {
      db.exec("ROLLBACK TO thesis_verdict; RELEASE thesis_verdict");
      throw e;
    }
  };

  if (blocked()) return deferred();

  // 0 — kill-switch mode: protocol reverted → the stop fires as placed, no LLM in the loop.
  if (getState(db, JDG_MODE_KEY) === "mechanical") {
    const id = log("mechanical", "sell_now", []);
    if (id === null) return deferred();
    return { action: "sell_now", cls: "mechanical", votes: [], escalated: false, corroborated: null, floorPrice9: floor, hash, verdictId: id, notes: ["judg:mode=mechanical — protocol bypassed"] };
  }

  // 1 — hard floor: CODE-enforced, runs BEFORE any model call and regardless of any model output.
  if (inp.currentPrice9 <= floor) {
    const id = log("floor_enforced", "sell_now", []);
    if (id === null) return deferred();
    return { action: "sell_now", cls: "floor_enforced", votes: [], escalated: false, corroborated: null, floorPrice9: floor, hash, verdictId: id, notes: [`price ${d9str(inp.currentPrice9)} ≤ −25% floor ${d9str(floor)}`] };
  }

  // 2 — Pass 1: risk-officer (bear) brief.
  const bear = await askJson(llm, "brief", [
    "ROLE: risk officer. Build the STRONGEST case that this position's thesis is impaired, and state",
    "exactly what disconfirming evidence would change your mind. Use ONLY the numbered evidence rows.",
    'Output JSON: {"impairment_case":"…","disconfirming_evidence_needed":"…","citations":[row numbers],"severity":"low|medium|high"}',
    positionBlock(inp), "Evidence:", claimsBlock(inp.claims),
  ].join("\n"), vBear, blocked);
  if (blocked()) return deferred();

  // 3 — Pass 2: independent intact-thesis brief (never sees Pass 1).
  const bull = await askJson(llm, "brief", [
    "ROLE: analyst. Build the strongest case that this position's ORIGINAL thesis remains intact and",
    "the drawdown is market noise or recoverable. Use ONLY the numbered evidence rows.",
    'Output JSON: {"intact_case":"…","citations":[row numbers],"confidence":"low|medium|high"}',
    positionBlock(inp), "Evidence:", claimsBlock(inp.claims),
  ].join("\n"), vBull, blocked);
  if (blocked()) return deferred();

  if (!bear || !bull) {
    // LLM failure fails CLOSED: hold with the floor + escalate to CJ. A model outage can neither
    // force a sale nor remove the floor.
    const id = log("llm_failure", "escalate_hold", []);
    if (id === null) return deferred();
    return { action: "escalate_hold", cls: "llm_failure", votes: [], escalated: true, corroborated: null, floorPrice9: floor, hash, verdictId: id, notes: ["brief generation failed after retry — held with floor, escalated"] };
  }

  // 4 — Pass 3: three independent judge votes. Judges see ONLY the two structured briefs.
  const judgePrompt = [
    "Classify this situation from the two briefs below. You never see raw sources — judge the",
    "briefs' internal evidence quality. A thesis_break means the reason for owning it is GONE",
    "(fraud, bankruptcy path, structural demand loss) — not merely a bad quarter.",
    'Output JSON: {"class":"thesis_break|partial_impairment|market_noise","probability":"low|medium|high","citations":[row numbers you found load-bearing]}',
    positionBlock(inp),
    `BEAR BRIEF (severity ${bear.severity}): ${bear.impairment_case}\nDisconfirming evidence needed: ${bear.disconfirming_evidence_needed}\nCites: ${JSON.stringify(bear.citations)}`,
    `BULL BRIEF (confidence ${bull.confidence}): ${bull.intact_case}\nCites: ${JSON.stringify(bull.citations)}`,
  ].join("\n");
  const votes: JudgeVote[] = [];
  for (let i = 0; i < 3; i++) {
    const v = await askJson(llm, "judge", judgePrompt, vVote, blocked);
    if (blocked()) return deferred();
    if (v) votes.push(v);
  }
  if (votes.length < 3) {
    const id = log("llm_failure", "escalate_hold", votes, bear.severity);
    if (id === null) return deferred();
    return { action: "escalate_hold", cls: "llm_failure", votes, escalated: true, corroborated: null, floorPrice9: floor, hash, verdictId: id, notes: [`only ${votes.length}/3 judge votes valid — held with floor, escalated`] };
  }

  // 5 — decision mapping IN CODE. Any single break vote escalates (asymmetric).
  const breakVotes = votes.filter((v) => v.class === "thesis_break").length;
  const majority: ThesisClass = breakVotes >= 2 ? "thesis_break"
    : votes.filter((v) => v.class === "partial_impairment").length >= 2 ? "partial_impairment"
    : votes.filter((v) => v.class === "market_noise").length >= 2 ? "market_noise"
    : "partial_impairment"; // 3-way split → middle class
  if (breakVotes === 0) {
    const id = log(majority, "hold_with_floor", votes, bear.severity);
    if (id === null) return deferred();
    return { action: "hold_with_floor", cls: majority, votes, escalated: false, corroborated: null, floorPrice9: floor, hash, verdictId: id, notes };
  }

  // 6 — break path: 2-source corroboration before sell-now is reachable. The bear brief's cited
  //     claims must span ≥2 distinct allowlisted sources; a single-source bombshell goes to CJ.
  const citedClaims = bear.citations.filter((i) => i >= 0 && i < inp.claims.length).map((i) => inp.claims[i]);
  const sources = distinctSources(citedClaims);
  const corroborated = sources.length >= 2;
  if (corroborated) {
    const id = log("thesis_break", "sell_now", votes, bear.severity);
    if (id === null) return deferred();
    return { action: "sell_now", cls: "thesis_break", votes, escalated: true, corroborated, floorPrice9: floor, hash, verdictId: id, notes: [`${breakVotes}/3 break votes; sources: ${sources.join(", ")}`] };
  }
  const id = log("thesis_break", "escalate_hold", votes, bear.severity);
  if (id === null) return deferred();
  return {
    action: "escalate_hold", cls: "thesis_break", votes, escalated: true, corroborated, floorPrice9: floor, hash, verdictId: id,
    notes: [`break vote(s) on a single source (${sources.join(", ") || "none"}) — held with floor, CJ's call`],
  };
}
