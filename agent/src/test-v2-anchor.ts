// Offline tests — v2 ANCHOR sleeve (13F best-ideas clone): info-table parsing, clone math (top-5,
// recursion, 40% cap, aggregation), amendment/restatement law, re-trade gate, drift band, all 7
// drift-watch detectors, mapping failures, and the end-to-end filing-evening → next-open flow.
// :memory: SQLite + authored XML fixtures + mock broker/ports; no network, no env.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, getState } from "./v2/db.js";
import { d9, d9str, div9, mul9, ONE9, type D9 } from "./v2/decimal.js";
import { loadConfig, DEFAULTS_PATH } from "./v2/config.js";
import { seedBook, recordCash } from "./v2/settled-cash.js";
import { ingestFill } from "./v2/lots.js";
import { markIntentStatus } from "./v2/order-gateway.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";
import type { EdgarPort, FilingRecord, CloneBuild, InfoTableLine, FilingSummary } from "./v2/sleeves/anchor/types.js";
import { parseInfoTable, valueUnitForPeriod } from "./v2/sleeves/anchor/infotable.js";
import { parseSubmissionsIndex, pickInfoTableFile, parseAmendmentType } from "./v2/sleeves/anchor/edgar.js";
import { fixtureMapping, mapLines } from "./v2/sleeves/anchor/mapping.js";
import { buildClone, summarize, compareBuilds, capAllocate, nonEquityReason } from "./v2/sleeves/anchor/clone.js";
import { storeFiling, getCurrentLines, latestBuild } from "./v2/sleeves/anchor/store.js";
import { driftWatch, filingDeadline, daysPastDeadline, flagDrift, type DriftCfg } from "./v2/sleeves/anchor/drift.js";
import { fixturePrices, ttmReturn9, top5TtmVsSpyPp9, quarterReturn9 } from "./v2/sleeves/anchor/prices.js";
import { planRebuild } from "./v2/sleeves/anchor/planner.js";
import { runFilingEvening, watchAmendments, tradeNextOpen, seedSleeveEquity9 } from "./v2/sleeves/anchor/index.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

const FIXDIR = fileURLToPath(new URL("./v2/sleeves/anchor/fixtures/", import.meta.url));
const fx = (name: string): string => readFileSync(FIXDIR + name, "utf8");

// Hermetic config: committed defaults, no local journal folded in.
const eff = loadConfig(DEFAULTS_PATH, DEFAULTS_PATH + ".no-journal-for-tests");
const ANCHOR = eff.config.anchor;
const DRIFT_CFG: DriftCfg = ANCHOR.driftWatch;
const PERIOD = "2026-06-30";

const CUSIP_TICKER: Record<string, string> = {
  "037833100": "AAPL", "025816109": "AXP", "060505104": "BAC", "191216100": "KO", "166764100": "CVX",
  "674599105": "OXY", "615369105": "MCO",
  "369604301": "GE", "55354G100": "MSCI", "13646K108": "CP", "92826C839": "V", "78409V104": "SPGI",
  "023135106": "AMZN", "594918104": "MSFT", "30303M102": "META", "893641100": "TDG", "57636Q104": "MA",
  "46436E718": "SGOV",
  "084670702": "BRK.B", "02079K305": "GOOGL", "27579R104": "EWBC", "722304102": "PDD",
};

const LATEST_PRICES: Record<string, string> = {
  AAPL: "200", AXP: "300", BAC: "44", KO: "70", CVX: "152", GE: "192", MSCI: "567", MCO: "445",
  CP: "82", V: "340", AMZN: "222", MSFT: "454", META: "700", TDG: "1400", MA: "552",
  GOOGL: "194", EWBC: "102", PDD: "125", SPY: "560",
};

const CIK = { brk: "0001067983", tci: "0001647251", altarock: "0001631014", himalaya: "0001709323" };

function rec(cik: string, accession: string, form: string, filedDate: string, amendmentType?: string): FilingRecord {
  return { cik, period: PERIOD, accession, form, filedDate, ...(amendmentType ? { amendmentType } : {}) };
}
const RECS = {
  brk: rec(CIK.brk, "0000950123-26-100001", "13F-HR", "2026-08-14"),
  tci: rec(CIK.tci, "0000950123-26-100002", "13F-HR", "2026-08-14"),
  altarock: rec(CIK.altarock, "0000950123-26-100003", "13F-HR", "2026-08-14"),
  himalaya: rec(CIK.himalaya, "0000950123-26-100004", "13F-HR", "2026-08-14"),
  himalayaRestated: rec(CIK.himalaya, "0000950123-26-100009", "13F-HR/A", "2026-09-04", "RESTATEMENT"),
};
const TABLES: Record<string, string> = {
  [RECS.brk.accession]: fx("berkshire-2026q2.xml"),
  [RECS.tci.accession]: fx("tci-2026q2.xml"),
  [RECS.altarock.accession]: fx("altarock-2026q2.xml"),
  [RECS.himalaya.accession]: fx("himalaya-2026q2.xml"),
  [RECS.himalayaRestated.accession]: fx("himalaya-2026q2-restated.xml"),
};

/** Fixture EdgarPort over mutable per-CIK filing lists (newest first, like the real index). */
function fixtureEdgar(index: Record<string, FilingRecord[]>): EdgarPort {
  return {
    async filingIndex(cik) { return index[cik] ?? []; },
    async latest13F(cik, period) {
      const pool = (index[cik] ?? []).filter((r) => !period || r.period === period);
      return pool[0] ?? null;
    },
    async fetchInfoTable(accession) {
      const xml = TABLES[accession];
      if (!xml) throw new Error(`no fixture table for ${accession}`);
      return xml;
    },
  };
}

function mockBroker(): BrokerPort & { submits: BrokerOrderRequest[] } {
  const submits: BrokerOrderRequest[] = [];
  return {
    submits,
    async submit(req): Promise<SubmitResult> { submits.push(req); return { outcome: "accepted", order: { id: `oid-${submits.length}` } }; },
    async queryByClientOrderId() { return null; },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };
}

/** Synthetic InfoTableLine for detector tests. */
function ln(cusip: string, valueUsd: bigint, opts: Partial<InfoTableLine> = {}): InfoTableLine {
  return {
    nameOfIssuer: opts.nameOfIssuer ?? `ISSUER ${cusip}`,
    titleOfClass: opts.titleOfClass ?? "COM",
    cusip, valueUsd,
    shares: opts.shares ?? 1000n,
    shType: opts.shType ?? "SH",
    ...(opts.putCall ? { putCall: opts.putCall } : {}),
  };
}

console.log("v2 anchor:");

// ---------- info-table parsing ----------
{
  const brk = parseInfoTable(TABLES[RECS.brk.accession], PERIOD);
  check("parse: berkshire rows", brk.length === 7);
  const aapl = brk.find((l) => l.cusip === "037833100")!;
  check("parse: dollar values verbatim (post-2023)", aapl.valueUsd === 60000000000n && aapl.shares === 300000000n);
  check("parse: titleOfClass + shType", aapl.titleOfClass === "COM" && aapl.shType === "SH");

  const tci = parseInfoTable(TABLES[RECS.tci.accession], PERIOD);
  check("parse: namespace-prefixed (ns1:) table", tci.length === 7);
  const call = tci.find((l) => l.putCall);
  check("parse: putCall row captured", call?.putCall === "Call" && call.valueUsd === 3800000000n);
  check("parse: XML entity decoded", tci.some((l) => l.nameOfIssuer === "S&P GLOBAL INC"));

  // Pre-2023 filings report THOUSANDS — normalization multiplies.
  const old = parseInfoTable(
    `<informationTable><infoTable><nameOfIssuer>X</nameOfIssuer><titleOfClass>COM</titleOfClass>
     <cusip>123456789</cusip><value>1000</value><shrsOrPrnAmt><sshPrnamt>10</sshPrnamt>
     <sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>`, "2022-09-30");
  check("parse: pre-2023 thousands ×1000", old[0].valueUsd === 1000000n);
  check("parse: unit boundary", valueUnitForPeriod("2022-12-31") === "dollars" && valueUnitForPeriod("2022-09-30") === "thousands");

  let threw = false;
  try { parseInfoTable(`<informationTable><infoTable><nameOfIssuer>X</nameOfIssuer></infoTable></informationTable>`, PERIOD); }
  catch { threw = true; }
  check("parse: incomplete row throws (never silently dropped)", threw);
}

// ---------- non-equity classification ----------
{
  check("filter: option row", nonEquityReason(ln("1", 1n, { putCall: "Call" })) === "option-row");
  check("filter: PRN debt row", nonEquityReason(ln("1", 1n, { shType: "PRN" })) === "non-share");
  check("filter: ISHARES parking ETF", nonEquityReason(ln("1", 1n, { nameOfIssuer: "ISHARES TR" })) === "parking-etf");
  check("filter: preferred class", nonEquityReason(ln("1", 1n, { titleOfClass: "7.5% PFD" })) === "non-common-class");
  check("filter: common passes", nonEquityReason(ln("1", 1n)) === null);
}

// ---------- pure clone core on the fixture set ----------
const mappingAll = fixtureMapping(CUSIP_TICKER);
const managerTables = await (async () => {
  const managers = ANCHOR.managers as { name: string; cik: string }[];
  const parsed: Record<string, string> = {
    [CIK.brk]: TABLES[RECS.brk.accession], [CIK.tci]: TABLES[RECS.tci.accession],
    [CIK.altarock]: TABLES[RECS.altarock.accession], [CIK.himalaya]: TABLES[RECS.himalaya.accession],
  };
  const out = [];
  for (const m of managers) out.push({ manager: m, lines: await mapLines(mappingAll, parseInfoTable(parsed[m.cik], PERIOD)) });
  return out;
})();

{
  const build = buildClone(managerTables, { topN: ANCHOR.topN, lineCapOfSlot: ANCHOR.lineCapOfSlot }, PERIOD);
  const slot = (cik: string) => build.slots.find((s) => s.cik === cik)!;
  const syms = (cik: string) => slot(cik).lines.map((l) => l.symbol);

  // Top-5 by value; option + ETF rows filtered BEFORE selection (they'd otherwise displace V / MA).
  check("top-5: TCI keeps V, drops SPGI + the 3.8B call", syms(CIK.tci).join(",") === "GE,MSCI,MCO,CP,V");
  check("top-5: AltaRock keeps MA, drops the 1.0B SGOV row", syms(CIK.altarock).join(",") === "AMZN,MSFT,META,TDG,MA");
  check("top-5: Berkshire cuts OXY + MCO", syms(CIK.brk).join(",") === "AAPL,AXP,BAC,KO,CVX");

  // BRK.B recursion: dropped from Himalaya's top-5, renormalized over the remaining FOUR (AAPL at
  // #6 not promoted), weights still sum exactly to the slot.
  check("recursion: BRK.B excluded from Himalaya", syms(CIK.himalaya).join(",") === "GOOGL,BAC,EWBC,PDD");
  check("recursion: excluded with reason", slot(CIK.himalaya).excluded.some((e) => e.reason === "recursion"));
  check("recursion: #6 (AAPL) NOT promoted", !syms(CIK.himalaya).includes("AAPL"));

  // Slot equality + exactness: 4 equal slots of exactly 0.25 each; lines+residual sum exactly.
  for (const s of build.slots) {
    const sum = s.lines.reduce((a, l) => a + l.weight9, 0n) + s.residual9;
    check(`slot exact: ${s.manager} lines+residual == slotMass`, sum === s.slotMass9, `${d9str(sum)} vs ${d9str(s.slotMass9)}`);
    check(`slot equal: ${s.manager} slotMass == 0.25`, s.slotMass9 === 250000000n);
  }

  // 40% line cap: AMZN is 47.6% of AltaRock's top-5 → frozen at 0.10 of sleeve (0.4 × 0.25),
  // excess redistributed proportionally over the other four (all stay under the cap).
  const amzn = slot(CIK.altarock).lines.find((l) => l.symbol === "AMZN")!;
  const cap9 = mul9(250000000n, d9(ANCHOR.lineCapOfSlot));
  check("cap: AMZN frozen at 40% of slot", amzn.weight9 === cap9, d9str(amzn.weight9));
  check("cap: others below cap after redistribution", slot(CIK.altarock).lines.every((l) => l.symbol === "AMZN" || l.weight9 < cap9));
  check("cap: no residual (redistribution absorbed the excess)", slot(CIK.altarock).residual9 === 0n);

  // Aggregation: 18 distinct tickers; BAC merged across Berkshire + Himalaya.
  check("aggregate: 18 distinct tickers", build.targets.size === 18, String(build.targets.size));
  const bacSlots = build.slots.flatMap((s) => s.lines.filter((l) => l.symbol === "BAC").map((l) => l.weight9));
  check("aggregate: BAC = Berkshire + Himalaya weights", bacSlots.length === 2 && build.targets.get("BAC") === bacSlots[0] + bacSlots[1]);
  check("aggregate: Σ targets == 1.0 EXACTLY", build.totalWeight9 === ONE9, d9str(build.totalWeight9));
  check("aggregate: no mapping flags with full table", build.flags.length === 0);
}

// ---------- cap water-fill edge: infeasible cap leaves residual ----------
{
  const { weights9, residual9 } = capAllocate(250000000n, [900n, 100n], d9("0.4"));
  check("cap edge: 2 lines both capped", weights9[0] === 100000000n && weights9[1] === 100000000n);
  check("cap edge: residual = slot − 2×cap", residual9 === 50000000n);
}

// ---------- mapping failure: flagged + dropped, never guessed ----------
{
  const noAmzn = { ...CUSIP_TICKER };
  delete (noAmzn as any)["023135106"];
  const tables = [];
  for (const t of managerTables) {
    tables.push({ manager: t.manager, lines: await mapLines(fixtureMapping(noAmzn), t.lines) });
  }
  const build = buildClone(tables, { topN: ANCHOR.topN, lineCapOfSlot: ANCHOR.lineCapOfSlot }, PERIOD);
  check("mapping: unmapped top-5 line flagged", build.flags.length === 1 && build.flags[0].reason === "mapping-failure" && build.flags[0].cusip === "023135106");
  check("mapping: AMZN dropped, not guessed", !build.targets.has("AMZN") && build.targets.size === 17);
  const alta = build.slots.find((s) => s.cik === CIK.altarock)!;
  const sum = alta.lines.reduce((a, l) => a + l.weight9, 0n) + alta.residual9;
  check("mapping: AltaRock renormalized over survivors, still exact", alta.lines.length === 4 && sum === alta.slotMass9);
}

// ---------- re-trade gate: membership change / >2pp weight move ----------
{
  const synth = (targets: Record<string, string>, lineSyms: string[]): CloneBuild => ({
    periodTag: PERIOD,
    slots: [{ manager: "M", cik: "C1", slotMass9: ONE9, residual9: 0n, excluded: [],
      lines: lineSyms.map((s) => ({ symbol: s, cusip: s, weight9: 0n, valueUsd: 0n })) }],
    targets: new Map(Object.entries(targets).map(([k, v]) => [k, d9(v)])),
    totalWeight9: ONE9, flags: [],
  });
  const prev = synth({ A: "0.5", B: "0.5" }, ["A", "B"]);
  const g19 = compareBuilds(prev, synth({ A: "0.519", B: "0.481" }, ["A", "B"]), ANCHOR.retradeWeightMovePp);
  check("gate: 1.9pp move → NO trade", !g19.retrade && !g19.membershipChanged && g19.maxMovePp9 === d9("1.9"));
  const g20 = compareBuilds(prev, synth({ A: "0.52", B: "0.48" }, ["A", "B"]), ANCHOR.retradeWeightMovePp);
  check("gate: exactly 2.0pp → NO trade (strict >)", !g20.retrade);
  const g21 = compareBuilds(prev, synth({ A: "0.521", B: "0.479" }, ["A", "B"]), ANCHOR.retradeWeightMovePp);
  check("gate: 2.1pp move → trade", g21.retrade && g21.maxMovePp9 === d9("2.1"));
  const gm = compareBuilds(prev, synth({ A: "0.5", C: "0.5" }, ["A", "C"]), ANCHOR.retradeWeightMovePp);
  check("gate: membership change → trade", gm.retrade && gm.membershipChanged);
}

// ---------- drift band: 20% relative, strict ----------
{
  const base = {
    targets: new Map([["X", ONE9]]),
    prices: new Map([["X", d9("10")]]),
    sleeveEquity9: d9("1000"),
    driftBandRel: ANCHOR.driftBandRel,
    reason: "test",
  };
  const p19 = planRebuild({ ...base, positions: new Map([["X", d9("81")]]) }); // current $810 vs $1000 → 19%
  check("band: 19% relative drift → no order", p19.orders.length === 0);
  const p21 = planRebuild({ ...base, positions: new Map([["X", d9("79")]]) }); // $790 → 21%
  check("band: 21% relative drift → buy the gap", p21.orders.length === 1 && p21.orders[0].side === "buy" && p21.orders[0].notional9 === d9("210"));
  const pSell = planRebuild({ ...base, positions: new Map([["X", d9("121")]]) }); // $1210 → 21% over
  check("band: 21% over → sell the gap in shares", pSell.orders.length === 1 && pSell.orders[0].side === "sell" && pSell.orders[0].qty9 === d9("21"));

  // Manager-follow: held but untargeted → full exit, ordered before buys.
  const pFollow = planRebuild({
    ...base,
    positions: new Map([["Z", d9("5")], ["X", d9("79")]]),
    prices: new Map([["X", d9("10")], ["Z", d9("10")]]),
  });
  check("manager-follow: full-qty sell first, then buy", pFollow.orders.length === 2 &&
    pFollow.orders[0].symbol === "Z" && pFollow.orders[0].side === "sell" && pFollow.orders[0].qty9 === d9("5") &&
    pFollow.orders[0].reason === "manager-follow" && pFollow.orders[1].side === "buy");

  const pNoPrice = planRebuild({ ...base, positions: new Map(), prices: new Map() });
  check("band: unpriceable symbol surfaces as problem, no order", pNoPrice.orders.length === 0 && pNoPrice.problems.length === 1);
}

// ---------- amendment law in the store: RESTATEMENT replaces, NEW HOLDINGS adds ----------
{
  const db = openDb(":memory:");
  const orig = parseInfoTable(TABLES[RECS.himalaya.accession], PERIOD);
  storeFiling(db, RECS.himalaya, orig);
  check("store: idempotent by accession", storeFiling(db, RECS.himalaya, orig).inserted === false);
  check("store: current = original (6 lines)", getCurrentLines(db, CIK.himalaya, PERIOD).length === 6);

  const restated = parseInfoTable(TABLES[RECS.himalayaRestated.accession], PERIOD);
  const res = storeFiling(db, RECS.himalayaRestated, restated);
  check("store: RESTATEMENT supersedes", res.inserted && res.restated);
  const cur = getCurrentLines(db, CIK.himalaya, PERIOD);
  check("store: current = restated table only (5 lines)", cur.length === 5);
  check("store: PDD gone after restatement", !cur.some((l) => l.cusip === "722304102"));

  // NEW HOLDINGS (confidential-treatment reveal) is ADDITIVE.
  const db2 = openDb(":memory:");
  storeFiling(db2, RECS.brk, parseInfoTable(TABLES[RECS.brk.accession], PERIOD));
  const reveal = rec(CIK.brk, "0000950123-26-100050", "13F-HR/A", "2026-10-20", "NEW HOLDINGS");
  storeFiling(db2, reveal, [ln("999999999", 5000000000n, { nameOfIssuer: "SECRET NEWCO" })]);
  check("store: NEW HOLDINGS concatenates (7+1)", getCurrentLines(db2, CIK.brk, PERIOD).length === 8);
  // An untyped /A restates (conservative default).
  const untyped = rec(CIK.brk, "0000950123-26-100051", "13F-HR/A", "2026-10-25");
  storeFiling(db2, untyped, [ln("888888888", 1n, { nameOfIssuer: "ONLY LINE" })]);
  check("store: untyped /A treated as restatement", getCurrentLines(db2, CIK.brk, PERIOD).length === 1);
}

// ---------- drift-watch detectors (warn + eject edges) ----------
{
  const S = (period: string, lines: InfoTableLine[]): FilingSummary => summarize("C", "Mgr", period, lines);
  const run = (summaries: FilingSummary[], extra: Partial<Parameters<typeof driftWatch>[0]> = {}) =>
    driftWatch({ manager: "Mgr", cik: "C", summaries, ...extra }, DRIFT_CFG);
  const of = (hits: ReturnType<typeof driftWatch>, det: string) => hits.filter((h) => h.detector === det);
  const cus = (n: number, tag = "A") => `${tag}${String(n).padStart(8, "0")}`;

  // 1. Deconcentration — top-10 share floor (strictly below 50%) + 2-consecutive eject.
  const equal20 = (p: string) => S(p, Array.from({ length: 20 }, (_, i) => ln(cus(i), 100n)));
  const equal21 = (p: string) => S(p, Array.from({ length: 21 }, (_, i) => ln(cus(i), 100n)));
  check("decon: top-10 exactly 50% → clean", of(run([equal20("2026-06-30")]), "deconcentration").length === 0);
  const dw = of(run([equal21("2026-06-30")]), "deconcentration");
  check("decon: top-10 47.6% → warn", dw.length === 1 && dw[0].level === "warn");
  const de = of(run([equal21("2026-03-31"), equal21("2026-06-30")]), "deconcentration");
  check("decon: 2 consecutive → eject", de.length === 1 && de[0].level === "eject");
  // top-5 −20pp QoQ (80% → 60%) → warn; three sliding quarters of −18pp → eject.
  const conc = (p: string, top: bigint, bottom: bigint) =>
    S(p, [...Array.from({ length: 5 }, (_, i) => ln(cus(i, "T"), top)), ...Array.from({ length: 5 }, (_, i) => ln(cus(i, "B"), bottom))]);
  const drop = of(run([conc("2026-03-31", 160n, 40n), conc("2026-06-30", 120n, 80n)]), "deconcentration");
  check("decon: top-5 −20pp QoQ → warn", drop.length === 1 && drop[0].level === "warn");
  const drop2 = of(run([conc("2025-12-31", 180n, 20n), conc("2026-03-31", 144n, 56n), conc("2026-06-30", 108n, 92n)]), "deconcentration");
  check("decon: −18pp twice consecutively → eject", drop2.length === 1 && drop2[0].level === "eject");

  // 2. Name churn — share of last quarter's names GONE (strict >30%/>50%).
  const names = (p: string, keep: number, fresh: number) =>
    S(p, [...Array.from({ length: keep }, (_, i) => ln(cus(i, "K"), 100n)), ...Array.from({ length: fresh }, (_, i) => ln(cus(i, `N${p.slice(5, 7)}`), 100n))]);
  check("churn: exactly 30% → clean", of(run([names("2026-03-31", 7, 3), names("2026-06-30", 7, 3)]), "name-churn").length === 0);
  const cw = of(run([names("2026-03-31", 6, 4), names("2026-06-30", 6, 4)]), "name-churn");
  check("churn: 40% → warn", cw.length === 1 && cw[0].level === "warn");
  const ce = of(run([names("2026-03-31", 4, 6), names("2026-06-30", 4, 6)]), "name-churn");
  check("churn: 60% → eject", ce.length === 1 && ce[0].level === "eject");

  // 3. Weight turnover — Σ|Δw|/2 (strict >20%/>35%), same names throughout.
  const two = (p: string, a: bigint, b: bigint) => S(p, [ln("W0000001", a), ln("W0000002", b)]);
  check("turnover: exactly 20% → clean", of(run([two("2026-03-31", 500n, 500n), two("2026-06-30", 300n, 700n)]), "weight-turnover").length === 0);
  const tw = of(run([two("2026-03-31", 500n, 500n), two("2026-06-30", 250n, 750n)]), "weight-turnover");
  check("turnover: 25% → warn", tw.length === 1 && tw[0].level === "warn");
  const te = of(run([two("2026-03-31", 500n, 500n), two("2026-06-30", 100n, 900n)]), "weight-turnover");
  check("turnover: 40% → eject", te.length === 1 && te[0].level === "eject");

  // 4. Market-adjusted AUM anomaly — QoQ warn, cumulative 2-quarter eject.
  const flat = (p: string, per: bigint) => S(p, Array.from({ length: 10 }, (_, i) => ln(cus(i, "U"), per)));
  check("aum: exactly +25% adj → clean",
    of(run([flat("2026-03-31", 100000000n), flat("2026-06-30", 125000000n)], { spyQoQReturn9: [0n] }), "aum-anomaly").length === 0);
  const aw = of(run([flat("2026-03-31", 100000000n), flat("2026-06-30", 130000000n)], { spyQoQReturn9: [d9("0.02")] }), "aum-anomaly");
  check("aum: +30% vs +2% market (28% adj) → warn", aw.length === 1 && aw[0].level === "warn");
  const ae = of(run([flat("2025-12-31", 100000000n), flat("2026-03-31", 145000000n), flat("2026-06-30", 210000000n)],
    { spyQoQReturn9: [0n, 0n] }), "aum-anomaly");
  check("aum: +110% over 2 quarters → eject", ae.length === 1 && ae[0].level === "eject");

  // 5. Representativeness — options+ETF+non-common share of value (strict >10%/>25%).
  const mix = (p: string, com: bigint, etf: bigint) =>
    S(p, [ln("R0000001", com), ln("R0000002", etf, { nameOfIssuer: "ISHARES TR" })]);
  check("rep: exactly 10% → clean", of(run([mix("2026-06-30", 900n, 100n)]), "representativeness").length === 0);
  const rw = of(run([mix("2026-06-30", 890n, 110n)]), "representativeness");
  check("rep: 11% → warn", rw.length === 1 && rw[0].level === "warn");
  const re = of(run([mix("2026-06-30", 740n, 260n)]), "representativeness");
  check("rep: 26% → eject", re.length === 1 && re[0].level === "eject");

  // 6. Performance guard — prior top-5 TTM vs SPY (strict < −15pp warn; < −25pp ×2qtrs eject).
  const bench = [S("2026-06-30", [ln("P0000001", 500n), ln("P0000002", 500n)])];
  check("perf: −15pp exactly → clean", of(run(bench, { perf: { ttmVsSpyPp9: d9("-15") } }), "performance-guard").length === 0);
  const pw = of(run(bench, { perf: { ttmVsSpyPp9: d9("-16") } }), "performance-guard");
  check("perf: −16pp → warn", pw.length === 1 && pw[0].level === "warn");
  const pe = of(run(bench, { perf: { ttmVsSpyPp9: d9("-26"), prevTtmVsSpyPp9: d9("-26") } }), "performance-guard");
  check("perf: −26pp twice → eject", pe.length === 1 && pe[0].level === "eject");
  const pOne = of(run(bench, { perf: { ttmVsSpyPp9: d9("-26"), prevTtmVsSpyPp9: d9("-20") } }), "performance-guard");
  check("perf: −26pp once → warn only", pOne.length === 1 && pOne[0].level === "warn");

  // 7. Liveness — 5 days past deadline warns; ADV deregistration instant-ejects.
  check("liveness: 4 days late → clean", of(run([], { liveness: { period: PERIOD, daysLate: 4 } }), "liveness").length === 0);
  const lw = of(run([], { liveness: { period: PERIOD, daysLate: 5 } }), "liveness");
  check("liveness: 5 days late → warn", lw.length === 1 && lw[0].level === "warn");
  const le = of(run([], { liveness: { period: PERIOD, advDeregistered: true } }), "liveness");
  check("liveness: ADV deregistration → eject", le.length === 1 && le[0].level === "eject");

  // flagDrift persists to the approvals queue and never anything else.
  const db = openDb(":memory:");
  const ids = flagDrift(db, [...lw, ...le]);
  const rows = db.prepare("SELECT kind, status FROM approvals ORDER BY id").all() as any[];
  check("flags land in approvals as pending anchor-drift", ids.length === 2 && rows.every((r) => r.kind === "anchor-drift" && r.status === "pending"));
}

// ---------- filing deadlines (the design's Feb 14/17 · May 15 · Aug 14 · Nov 14) ----------
{
  check("deadline: Q2'26 → Fri 2026-08-14", filingDeadline("2026-06-30") === "2026-08-14");
  check("deadline: Q4'25 rolls Sat 14 → Tue 17 (Presidents Day)", filingDeadline("2025-12-31") === "2026-02-17");
  check("deadline: not late on deadline day", daysPastDeadline("2026-06-30", "2026-08-14") === 0);
  check("deadline: 5 days past", daysPastDeadline("2026-06-30", "2026-08-19") === 5);
}

// ---------- TTM performance math ----------
{
  const prices = fixturePrices({}, {
    X: { "2025-08-10": "100", "2026-08-10": "120" },
    Y: { "2025-08-10": "50", "2026-08-10": "50" },
    SPY: { "2025-08-10": "500", "2026-08-10": "650", "2026-03-31": "100", "2026-06-30": "102" },
  });
  check("ttm: (120−100)/100 = 0.2", (await ttmReturn9(prices, "X", "2026-08-10")) === d9("0.2"));
  // basket (X 20%, Y 0%) avg 10% vs SPY 30% → −20pp.
  check("ttm basket vs SPY in pp", (await top5TtmVsSpyPp9(prices, ["X", "Y"], "2026-08-10")) === d9("-20"));
  check("ttm: missing history → null, never zero", (await ttmReturn9(prices, "ZZZ", "2026-08-10")) === null);
  check("quarter return", (await quarterReturn9(prices, "2026-03-31", "2026-06-30")) === d9("0.02"));
}

// ---------- EDGAR pure helpers ----------
{
  const recs = parseSubmissionsIndex("1067983", {
    filings: { recent: {
      form: ["13F-HR", "10-K", "13F-HR/A"],
      accessionNumber: ["0000950123-26-000001", "0000950123-26-000002", "0000950123-26-000003"],
      reportDate: ["2026-06-30", "2025-12-31", "2026-03-31"],
      filingDate: ["2026-08-14", "2026-02-01", "2026-06-01"],
    } },
  });
  check("edgar: submissions index filters to 13F forms", recs.length === 2 && recs[0].form === "13F-HR" && recs[1].form === "13F-HR/A");
  check("edgar: CIK padded", recs[0].cik === "0001067983");
  check("edgar: info-table file by exclusion", pickInfoTableFile([{ name: "primary_doc.xml" }, { name: "infotable.xml" }]) === "infotable.xml");
  check("edgar: info-table file by pattern", pickInfoTableFile([{ name: "primary_doc.xml" }, { name: "form13fInfoTable.xml" }, { name: "0001.xml" }]) === "form13fInfoTable.xml");
  check("edgar: amendmentType extracted", parseAmendmentType("<amendmentInfo><amendmentType>restatement</amendmentType></amendmentInfo>") === "RESTATEMENT");
}

// ---------- end-to-end: filing evening → next open → restatement → focused re-trade ----------
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-14");
  const index: Record<string, FilingRecord[]> = {
    [CIK.brk]: [RECS.brk], [CIK.tci]: [RECS.tci], [CIK.altarock]: [RECS.altarock], [CIK.himalaya]: [RECS.himalaya],
  };
  const ports = { edgar: fixtureEdgar(index), mapping: mappingAll, prices: fixturePrices(LATEST_PRICES) };

  // Filing evening (Fri 2026-08-14, after the 4pm drops).
  const evening = await runFilingEvening(db, ports, eff, { period: PERIOD, today: "2026-08-14" });
  check("e2e: four new filings stored", evening.newFilings.length === 4 && evening.missing.length === 0);
  check("e2e: initial build gates to trade", evening.retrade && evening.retradeReason === "initial-build");
  check("e2e: pending-rebuild marker set", getState(db, "anc:pending_rebuild") !== null);
  check("e2e: TCI + AltaRock representativeness warns queued (14.9% / 10.6%)",
    evening.driftHits.filter((h) => h.detector === "representativeness" && h.level === "warn").length === 2);
  const evening2 = await runFilingEvening(db, ports, eff, { period: PERIOD, today: "2026-08-14" });
  check("e2e: evening idempotent (nothing re-stored)", evening2.newFilings.length === 0 && !evening2.retrade);

  // Next market open (Mon 2026-08-17): ~18 buys through the shared gateway.
  const broker = mockBroker();
  const equity9 = seedSleeveEquity9(eff);
  check("e2e: seed sleeve equity = 5000 × 0.25", equity9 === d9("1250"));
  const trade = await tradeNextOpen(db, broker, ports.prices, eff, { asOfDate: "2026-08-17", sleeveEquity9: equity9 });
  check("e2e: initial build places 18 buys", trade.traded && trade.execute?.placed === 18, JSON.stringify(trade.execute?.refused));
  check("e2e: coids owned by anc", broker.submits.every((s) => s.client_order_id.startsWith("anc:")));
  check("e2e: marker cleared after trading", getState(db, "anc:pending_rebuild") === null);
  const metaRows = db.prepare("SELECT COUNT(*) AS n FROM position_meta WHERE sleeve='anc'").get() as any;
  check("e2e: position_meta written for 18 targets", Number(metaRows.n) === 18);

  // Simulate the buys filling at fixture prices so the ledger holds the book.
  const intents = db.prepare("SELECT client_order_id, symbol, notional9 FROM order_intents WHERE sleeve='anc' AND side='buy' AND status='submitted'").all() as any[];
  for (const it of intents) {
    const px = d9(LATEST_PRICES[it.symbol]);
    ingestFill(db, {
      id: `fill-${it.client_order_id}`, symbol: it.symbol, side: "buy",
      qty9: div9(d9(it.notional9), px), price9: px, ts: "2026-08-17T14:35:00Z", sleeve: "anc",
    });
    markIntentStatus(db, it.client_order_id, "terminal:filled");
  }

  // Himalaya restates the quarter (the Q4'25 pattern) inside the 60-day watch window.
  index[CIK.himalaya] = [RECS.himalayaRestated, RECS.himalaya];
  const watch = await watchAmendments(db, ports, eff, { period: PERIOD, today: "2026-09-04" });
  check("e2e: amendment watch stores the /A and re-gates", watch.newFilings === 1 && watch.retrade);
  const rebuilt = latestBuild(db)!;
  check("e2e: restated build drops PDD, adds AAPL to Himalaya slot",
    !rebuilt.targets.has("PDD") &&
    rebuilt.slots.find((s) => s.cik === CIK.himalaya)!.lines.map((l) => l.symbol).join(",") === "GOOGL,BAC,EWBC,AAPL");
  check("e2e: restated Σ targets still exactly 1.0", rebuilt.totalWeight9 === ONE9);

  // Next open after the amendment: ONLY the outside-band lines trade — manager-follow sell of PDD,
  // top-up buy of AAPL (34% drift); GOOGL/BAC/EWBC moved <7% and stay put.
  const broker2 = mockBroker();
  const trade2 = await tradeNextOpen(db, broker2, ports.prices, eff, { asOfDate: "2026-09-08", sleeveEquity9: equity9 });
  check("e2e: focused re-trade = 2 orders", broker2.submits.length === 2, JSON.stringify(broker2.submits.map((s) => s.symbol)));
  check("e2e: PDD manager-follow sell first", broker2.submits[0]?.symbol === "PDD" && broker2.submits[0]?.side === "sell");
  check("e2e: AAPL top-up buy second", broker2.submits[1]?.symbol === "AAPL" && broker2.submits[1]?.side === "buy");
  check("e2e: re-trade reason recorded", trade2.reason === "membership-change");

  // Liveness through the orchestrator: a missing filer 5+ days past deadline lands in approvals.
  const dbMiss = openDb(":memory:");
  const missIndex = { ...index, [CIK.himalaya]: [] as FilingRecord[] };
  // Older quarters untouched: only himalaya missing for the period.
  const missEvening = await runFilingEvening(dbMiss, { ...ports, edgar: fixtureEdgar(missIndex) }, eff, { period: PERIOD, today: "2026-08-19" });
  check("e2e: missing filing flagged (liveness warn)",
    missEvening.missing.length === 1 && missEvening.driftHits.some((h) => h.detector === "liveness" && h.level === "warn"));
  const missRows = dbMiss.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='anchor-drift'").get() as any;
  check("e2e: liveness flag persisted to approvals", Number(missRows.n) >= 1);

  // Mapping failure through the orchestrator → anchor-mapping approvals row.
  const dbMap = openDb(":memory:");
  const noAmzn = { ...CUSIP_TICKER };
  delete (noAmzn as any)["023135106"];
  const mapEvening = await runFilingEvening(dbMap, { ...ports, mapping: fixtureMapping(noAmzn) }, eff, { period: PERIOD, today: "2026-08-14" });
  const mapRows = dbMap.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='anchor-mapping'").get() as any;
  check("e2e: mapping failure → approvals row, line dropped", mapEvening.mappingFlags === 1 && Number(mapRows.n) === 1 && !mapEvening.build!.targets.has("AMZN"));
})();

// ---------- cash-starved next-open keeps the pending marker for retry ----------
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-14");
  // Park the cash (the launch-week SGOV-sweep shape): settled drops to $10.
  recordCash(db, { ts: "2026-08-14T13:36:00Z", kind: "sweep_buy", symbol: "SGOV", amount9: -d9("4990"), settlesOn: "2026-08-14", ref: "park" });
  const index: Record<string, FilingRecord[]> = {
    [CIK.brk]: [RECS.brk], [CIK.tci]: [RECS.tci], [CIK.altarock]: [RECS.altarock], [CIK.himalaya]: [RECS.himalaya],
  };
  const ports = { edgar: fixtureEdgar(index), mapping: mappingAll, prices: fixturePrices(LATEST_PRICES) };
  await runFilingEvening(db, ports, eff, { period: PERIOD, today: "2026-08-14" });
  const broker = mockBroker();
  const trade = await tradeNextOpen(db, broker, ports.prices, eff, { asOfDate: "2026-08-17", sleeveEquity9: seedSleeveEquity9(eff) });
  check("cash-starved: nothing traded", trade.traded === false && trade.execute?.placed === 0, JSON.stringify(trade.execute?.refused?.slice(0, 2)));
  check("cash-starved: refusals are the settled-cash gate",
    (trade.execute?.refused.length ?? 0) > 0 && trade.execute!.refused.every((r) => r.result.skipped === "NO_SETTLED_CASH"),
    JSON.stringify(trade.execute?.refused.map((r) => r.result.skipped).slice(0, 4)));
  check("cash-starved: marker KEPT for retry", getState(db, "anc:pending_rebuild") !== null);
  check("cash-starved: no position_meta written yet",
    Number((db.prepare("SELECT COUNT(*) AS n FROM position_meta WHERE sleeve='anc'").get() as any).n) === 0);
})();

// ---------- structural rail: the sleeve never reads buying_power (mirrors the shared v2 grep,
// which only scans the top-level v2/ dir — this covers the anchor subtree) ----------
{
  const dir = fileURLToPath(new URL("./v2/sleeves/anchor/", import.meta.url));
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(dir + f, "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    if (/\.buying_power|\bbuying_power\s*[\]:]/.test(src) || /buyingPower/.test(src)) offenders.push(f);
  }
  check("no anchor source reads buying_power", offenders.length === 0, offenders.join(","));
}

console.log(failures ? `\n${failures} FAILED` : "\nall anchor tests passed");
if (failures) process.exit(1);
