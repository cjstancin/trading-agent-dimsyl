// Bull v2 — Anchor: the pure clone core. Turns four managers' mapped 13F tables into ONE target
// weight map for the sleeve. No I/O, no DB — every rule here is exercised offline by fixtures.
//
// The clone rule (design, verbatim intent):
//   1. filter non-equity lines (option rows, principal-amount debt, SGOV-type parking ETFs,
//      preferred/warrant/note classes) — these are cash management or hedges, not conviction;
//   2. take each manager's top-5 surviving holdings BY REPORTED VALUE;
//   3. drop a line whose issuer IS a slot manager (BRK.A/B inside another manager's top-5 while
//      Berkshire itself is a slot) — cloning it would double-count the same book (recursion);
//      an unmapped line inside the top-5 is likewise dropped (and flagged) — never guessed;
//   4. equal manager slots (sleeve/N each, split EXACTLY via allocate9 so four slots sum to 1);
//   5. within a slot, renormalize the surviving lines' 13F values to the slot mass with a 40%
//      line cap (water-fill: capped lines freeze at the cap, the excess redistributes
//      proportionally over the rest — iterated, because redistribution can push a new line over);
//   6. aggregate duplicate tickers across managers by summing their weights.
//
// Exactness: every slot's line weights + residual sum EXACTLY to its slot mass (allocate9 — no
// dust), so Σ targets + Σ residuals == 1.0 to the last d9 unit. Residual is only non-zero when a
// slot has so few survivors that lines × cap < slot (e.g. 2 lines × 40% = 80%) — that mass stays
// in cash by design rather than violating the cap.
import { d9, mul9, allocate9, ONE9, type D9 } from "../../decimal.js";
import type { ManagerCfg, MappedLine, ManagerSlot, CloneBuild, ExcludedLine, ExcludeReason, FilingSummary, InfoTableLine } from "./types.js";

/** Tickers of publicly-traded slot managers, by CIK — the recursion-exclusion set. Berkshire is
 *  the only current case; a future slot manager with a listed vehicle gets a row here. */
const SLOT_MANAGER_TICKERS: Record<string, string[]> = {
  "0001067983": ["BRK.A", "BRK.B"], // Berkshire Hathaway
};
const SLOT_MANAGER_ISSUER_RE: Record<string, RegExp> = {
  "0001067983": /\bBERKSHIRE\s+HATHAWAY\b/i,
};

/** ETF-family issuers (cash parking / index exposure — never a best-idea clone target). */
const ETF_ISSUER_RE = /\b(ISHARES|VANGUARD|SPDR|SELECT\s+SECTOR|INVESCO\s+(QQQ|ETF)|PROSHARES|WISDOMTREE|DIMENSIONAL\s+ETF|GLOBAL\s+X)\b/i;
/** Non-common titleOfClass markers (preferreds, warrants, notes, units, rights). */
const NON_COMMON_TITLE_RE = /\b(NOTE|NOTES|BOND|DEB|DEBENTURE|PFD|PREF|WT|WTS|WARRANT|UNIT|UNITS|RIGHT|RTS)\b/i;

/** Classify a line as non-cloneable. Returns the reason, or null when it's a common-equity line. */
export function nonEquityReason(line: InfoTableLine): ExcludeReason | null {
  if (line.putCall) return "option-row";
  if (line.shType !== "SH") return "non-share";
  if (ETF_ISSUER_RE.test(line.nameOfIssuer)) return "parking-etf";
  if (NON_COMMON_TITLE_RE.test(line.titleOfClass)) return "non-common-class";
  return null;
}

/** Is this line one of the slot managers' own listed vehicles? (recursion check) */
function recursionHit(line: MappedLine, managers: ManagerCfg[]): boolean {
  for (const m of managers) {
    const tickers = SLOT_MANAGER_TICKERS[m.cik];
    if (!tickers) continue;
    if (line.symbol && tickers.includes(line.symbol)) return true;
    const re = SLOT_MANAGER_ISSUER_RE[m.cik];
    if (re && re.test(line.nameOfIssuer)) return true;
  }
  return false;
}

/** Water-fill a slot's mass across lines by raw 13F value with a per-line cap (capFrac of the
 *  slot). Returns d9 weights aligned to `raws` + the un-allocatable residual. Exact: Σ out +
 *  residual === slotMass9 always (allocate9 inside; caps are exact d9 values). */
export function capAllocate(slotMass9: D9, raws: bigint[], capFrac9: D9): { weights9: D9[]; residual9: D9 } {
  const n = raws.length;
  const out = new Array<D9>(n).fill(0n);
  if (n === 0) return { weights9: out, residual9: slotMass9 };
  const cap9 = mul9(slotMass9, capFrac9);
  let active = raws.map((_, i) => i).filter((i) => raws[i] > 0n);
  let remaining = slotMass9;
  while (active.length > 0 && remaining > 0n) {
    const alloc = allocate9(remaining, active.map((i) => raws[i]));
    const over: number[] = [];
    for (let k = 0; k < active.length; k++) if (alloc[k] > cap9) over.push(active[k]);
    if (over.length === 0) {
      for (let k = 0; k < active.length; k++) out[active[k]] = alloc[k];
      return { weights9: out, residual9: 0n };
    }
    for (const i of over) { out[i] = cap9; remaining -= cap9; }
    active = active.filter((i) => !over.includes(i));
  }
  return { weights9: out, residual9: remaining };
}

export interface ManagerTable {
  manager: ManagerCfg;
  lines: MappedLine[];
}

/** Build the sleeve's target weights from the four managers' mapped tables. Pure. */
export function buildClone(tables: ManagerTable[], cfg: {
  topN: number;                 // 5
  lineCapOfSlot: number;        // 0.4
}, periodTag: string): CloneBuild {
  const managers = tables.map((t) => t.manager);
  const capFrac9 = d9(cfg.lineCapOfSlot);
  // Equal slots, exact: allocate9 splits 1.0 into N parts that sum to exactly ONE9.
  const slotMasses = allocate9(ONE9, tables.map(() => 1n));

  const slots: ManagerSlot[] = [];
  const flags: ExcludedLine[] = [];

  for (let t = 0; t < tables.length; t++) {
    const { manager, lines } = tables[t];
    const excluded: ExcludedLine[] = [];

    // 1. Non-equity filter BEFORE top-5 — parking/option rows must not occupy conviction slots.
    const equity: MappedLine[] = [];
    for (const line of lines) {
      const reason = nonEquityReason(line);
      if (reason) excluded.push({ reason, nameOfIssuer: line.nameOfIssuer, cusip: line.cusip, valueUsd: line.valueUsd });
      else equity.push(line);
    }

    // 2. Top-N by reported value (stable tiebreak by cusip for determinism).
    const top = [...equity]
      .sort((a, b) => (a.valueUsd === b.valueUsd ? (a.cusip < b.cusip ? -1 : 1) : a.valueUsd > b.valueUsd ? -1 : 1))
      .slice(0, cfg.topN);

    // 3. Recursion + mapping-failure drops WITHIN the top-5, then renormalize over survivors
    //    (design: drop + renormalize — the #6 holding does NOT get promoted; a manager's 6th-best
    //    idea was not what CJ locked the clone to).
    const survivors: MappedLine[] = [];
    for (const line of top) {
      if (recursionHit(line, managers)) {
        excluded.push({ reason: "recursion", nameOfIssuer: line.nameOfIssuer, cusip: line.cusip, valueUsd: line.valueUsd });
        continue;
      }
      if (!line.symbol) {
        const flag: ExcludedLine = {
          reason: "mapping-failure", nameOfIssuer: line.nameOfIssuer, cusip: line.cusip, valueUsd: line.valueUsd,
          detail: `top-${cfg.topN} line of ${manager.name} has no CUSIP→ticker mapping — resolve manually`,
        };
        excluded.push(flag);
        flags.push(flag);
        continue;
      }
      survivors.push(line);
    }

    // 4/5. Slot renormalization with the 40% line cap.
    const { weights9, residual9 } = capAllocate(slotMasses[t], survivors.map((l) => l.valueUsd), capFrac9);
    slots.push({
      manager: manager.name,
      cik: manager.cik,
      slotMass9: slotMasses[t],
      lines: survivors.map((l, i) => ({ symbol: l.symbol!, cusip: l.cusip, weight9: weights9[i], valueUsd: l.valueUsd })),
      excluded,
      residual9,
    });
  }

  // 6. Cross-manager aggregation: duplicate tickers merge by weight sum.
  const targets = new Map<string, D9>();
  for (const slot of slots) {
    for (const line of slot.lines) targets.set(line.symbol, (targets.get(line.symbol) ?? 0n) + line.weight9);
  }
  let totalWeight9 = 0n;
  for (const w of targets.values()) totalWeight9 += w;

  return { periodTag, slots, targets, totalWeight9, flags };
}

/** Summarize a manager's CURRENT (post-amendment) table for the drift-watch detectors. Weights are
 *  keyed by CUSIP (mapping-independent — drift must still work when a ticker won't resolve). */
export function summarize(cik: string, manager: string, period: string, lines: InfoTableLine[]): FilingSummary {
  let total = 0n;
  let nonEquity = 0n;
  const byCusip = new Map<string, bigint>();
  for (const l of lines) {
    total += l.valueUsd;
    if (nonEquityReason(l)) nonEquity += l.valueUsd;
    byCusip.set(l.cusip, (byCusip.get(l.cusip) ?? 0n) + l.valueUsd);
  }
  const ranked = [...byCusip.entries()].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1));
  const share = (vals: bigint[]): D9 => {
    if (total === 0n) return 0n;
    const sum = vals.reduce((a, b) => a + b, 0n);
    return (sum * ONE9) / total; // floor division — fine for threshold comparisons
  };
  const weights = new Map<string, D9>();
  for (const [cusip, v] of byCusip) weights.set(cusip, total === 0n ? 0n : (v * ONE9) / total);
  return {
    cik, manager, period,
    totalValueUsd: total,
    count: lines.length,
    weights,
    top5Keys: ranked.slice(0, 5).map(([c]) => c),
    top5Share9: share(ranked.slice(0, 5).map(([, v]) => v)),
    top10Share9: share(ranked.slice(0, 10).map(([, v]) => v)),
    nonEquityShare9: total === 0n ? 0n : (nonEquity * ONE9) / total,
  };
}

/** Re-trade gate (design): after an amendment/recompute, trade ONLY when top-5 membership changed
 *  or some aggregate weight moved by MORE than `retradeWeightMovePp` percentage points. */
export function compareBuilds(prev: CloneBuild, next: CloneBuild, retradeWeightMovePp: number): {
  membershipChanged: boolean;
  maxMovePp9: D9;                 // largest |Δweight| in d9 PERCENTAGE POINTS (weight × 100)
  retrade: boolean;
} {
  // Membership: per-manager top-5 line sets (matched by cik so manager order doesn't matter).
  let membershipChanged = false;
  const prevByCik = new Map(prev.slots.map((s) => [s.cik, new Set(s.lines.map((l) => l.symbol))]));
  for (const slot of next.slots) {
    const prevSet = prevByCik.get(slot.cik);
    const nextSet = new Set(slot.lines.map((l) => l.symbol));
    if (!prevSet || prevSet.size !== nextSet.size || [...nextSet].some((s) => !prevSet.has(s))) {
      membershipChanged = true;
      break;
    }
  }
  // Weight moves over the union of aggregate targets, in pp (weight fraction × 100).
  let maxMove9 = 0n;
  const keys = new Set([...prev.targets.keys(), ...next.targets.keys()]);
  for (const k of keys) {
    const a = prev.targets.get(k) ?? 0n;
    const b = next.targets.get(k) ?? 0n;
    const diff = a > b ? a - b : b - a;
    if (diff > maxMove9) maxMove9 = diff;
  }
  const maxMovePp9 = maxMove9 * 100n;               // d9 fraction × 100 = d9 pp
  const threshold9 = d9(retradeWeightMovePp);        // config pp as d9
  return { membershipChanged, maxMovePp9, retrade: membershipChanged || maxMovePp9 > threshold9 };
}
