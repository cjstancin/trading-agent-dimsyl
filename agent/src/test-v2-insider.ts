// Offline tests — v2 insider sleeve: Form 4 parser (fixtures), cluster engine, capacity/selection
// planner, liquidity + spread gates, exits (horizon/reversal/reset/amendment/stop), shadow book +
// CAR math, EDGAR feed parsing. :memory: SQLite, fixture XML, mock broker/ports — no network, no
// env. Thresholds come from loadConfig() (the journaled config), so a config amendment moves the
// tests' expectations with it.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, getState } from "./v2/db.js";
import { d9, d9str, type D9 } from "./v2/decimal.js";
import { loadConfig } from "./v2/config.js";
import { seedBook } from "./v2/settled-cash.js";
import { ingestFill } from "./v2/lots.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";
import { parseForm4, classifyTxn, txnValue9, primaryOwner, type ParsedForm4 } from "./v2/sleeves/insider/form4.js";
import {
  detectClusters, evaluateWindow, scoreCluster, isRoutineBuyer, isPureOwnerEntity, dayDiff,
  type BuyEvent, type Cluster, type ClusterCfg, type ClusterParticipant,
} from "./v2/sleeves/insider/cluster.js";
import {
  ensureInsiderTables, storeForm4, qualifiedBuyEvents, ownerHistoryFn, upsertCluster, getCluster,
  participantSells, accessionSeen,
} from "./v2/sleeves/insider/store.js";
import { medianDollarVolume9, passesLiquidityFloor, spreadOk } from "./v2/sleeves/insider/liquidity.js";
import {
  slotCount, slotNotional9, decideEntries, executeEntries, mid9,
  type CandidateSnapshot, type EntryDecision,
} from "./v2/sleeves/insider/planner.js";
import {
  addMonths, horizonDue, detectReversal, tryClockReset, readMeta, writeMeta, runExits,
  atrStopLevel9, requalifyCluster, type InsPositionMeta,
} from "./v2/sleeves/insider/exits.js";
import { recordSignal, markFunded, computeCar, updateShadowCars } from "./v2/sleeves/insider/shadow.js";
import {
  parseAtomForm4Entries, parseDailyIndexForm4, shouldPollNow, pollDelaySeconds, pollOnce,
  reconcileDaily, processAccession,
} from "./v2/sleeves/insider/ingest.js";
import { dailyIndexUrl, accessionNoDashes } from "./v2/sleeves/insider/edgar.js";
import { sectorPortStub } from "./v2/sleeves/insider/market.js";
import type { DailyBar, EdgarPort, PricePort } from "./v2/sleeves/insider/ports.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}
function near(a: number | null, b: number, eps = 1e-9): boolean {
  return a !== null && Math.abs(a - b) < eps;
}

const eff = loadConfig();
const INS = eff.config.insider;
const CL: ClusterCfg = INS.cluster;
const LIQ = INS.liquidity;
const CAP = INS.capacity;
const EXITCFG = INS.exit;
const BENCH: string = eff.config.benchmarks.ins;
const WBL: number = eff.config.ledger.washBlacklistDays;

const fx = (name: string): string =>
  readFileSync(new URL(`./v2/sleeves/insider/fixtures/${name}`, import.meta.url), "utf8");

function mockBroker(script: { submit?: SubmitResult[] } = {}): BrokerPort & { submits: BrokerOrderRequest[] } {
  const submits: BrokerOrderRequest[] = [];
  const submitScript = [...(script.submit ?? [])];
  return {
    submits,
    async submit(req) { submits.push(req); return submitScript.shift() ?? { outcome: "accepted", order: { id: `oid-${submits.length}`, status: "accepted" } }; },
    async queryByClientOrderId() { return null; },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };
}

/** Ascending weekday sessions starting at `start`. */
function genSessions(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T12:00:00Z");
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function mkBuy(o: {
  cik: string; date: string; usd: number; officer?: boolean; director?: boolean; tenPct?: boolean;
  title?: string | null; name?: string; symbol?: string; sharesAfter?: string | null;
}): BuyEvent {
  const officer = o.officer ?? true;
  return {
    symbol: o.symbol ?? "TEST", issuerCik: "100",
    ownerCik: o.cik, ownerName: o.name ?? `Person ${o.cik}`,
    isOfficer: officer, isDirector: !!o.director, isTenPercentOwner: !!o.tenPct,
    officerTitle: o.title !== undefined ? o.title : (officer ? "Officer" : null),
    tradeDate: o.date, shares9: d9("1000"), value9: d9(o.usd),
    sharesAfter9: o.sharesAfter === null ? null : d9(o.sharesAfter ?? "5000"),
  };
}
const NO_HIST = (): string[] => [];

function mkParsed(o: {
  docType?: string; cik: string; name: string; officer?: boolean; director?: boolean; tenPct?: boolean;
  title?: string | null; date: string; code?: string; ad?: string; shares: string; price: string;
  sharesAfter?: string | null; symbol?: string; issuerCik?: string;
}): ParsedForm4 {
  return {
    documentType: o.docType ?? "4",
    periodOfReport: o.date,
    aff10b5One: false,
    issuerCik: o.issuerCik ?? "1111111",
    issuerName: "KVH Industries Test Corp",
    symbol: o.symbol ?? "KVHI",
    owners: [{
      cik: o.cik, name: o.name, isDirector: !!o.director, isOfficer: !!o.officer,
      isTenPercentOwner: !!o.tenPct, isOther: false, officerTitle: o.title ?? null,
    }],
    txns: [{
      table: "nonDerivative", code: o.code ?? "P", acquiredDisposed: o.ad ?? "A", date: o.date,
      shares9: d9(o.shares), price9: d9(o.price),
      sharesAfter9: o.sharesAfter === null ? null : d9(o.sharesAfter ?? "10000"), footnoteIds: [],
    }],
    footnotes: {},
    remarks: "",
  };
}

function mkPart(o: {
  cik: string; officer?: boolean; director?: boolean; tenPct?: boolean; title?: string | null;
  firstEver?: boolean; name?: string;
}): ClusterParticipant {
  return {
    cik: o.cik, name: o.name ?? `Person ${o.cik}`,
    isOfficer: o.officer ?? false, isDirector: !!o.director, isTenPercentOwner: !!o.tenPct,
    officerTitle: o.title ?? null, value9: "40000", shares9: "1000", deltaOwnFrac: 0,
    firstEver: !!o.firstEver,
  };
}

function mkCluster(sym: string, score: number, id?: string): Cluster {
  return {
    clusterId: id ?? `ins:${sym}:2026-08-10`, symbol: sym, issuerCik: "100",
    windowStart: "2026-08-01", windowEnd: "2026-08-10",
    participants: [mkPart({ cik: "1", officer: true, title: "Chief Financial Officer" })],
    aggregate9: d9("120000"), officerCount: 1, directorCount: 0, score,
  };
}

function mkBars(n: number, close: string, vol: string): DailyBar[] {
  return genSessions("2026-06-01", n).map((date) => ({ date, close9: d9(close), volume9: d9(vol) }));
}

function mkSnap(sym: string, score: number, over: Partial<CandidateSnapshot> = {}): CandidateSnapshot {
  return {
    cluster: mkCluster(sym, score),
    bars: mkBars(25, "10", "30000"),
    quote: { bid9: d9("9.99"), ask9: d9("10.01") },
    marketCap9: d9("100000000"),
    asset: { fractionable: true, exchange: "NASDAQ", tradable: true },
    sector: "Tech",
    ...over,
  };
}

console.log("v2 insider sleeve:");

// ---------- Form 4 parser: every fixture ----------
{
  const f = parseForm4(fx("p-buy-clean.xml"));
  check("clean P-buy: doc/symbol/issuer parsed", f.documentType === "4" && f.symbol === "KVHI" && f.issuerCik === "1111111");
  check("clean P-buy: owner is CFO officer", f.owners.length === 1 && f.owners[0].cik === "2222222"
    && f.owners[0].isOfficer && !f.owners[0].isDirector && /Chief Financial/.test(f.owners[0].officerTitle ?? ""));
  check("clean P-buy: txn fields exact (d9)", f.txns.length === 1 && f.txns[0].code === "P"
    && f.txns[0].acquiredDisposed === "A" && f.txns[0].date === "2026-08-06"
    && f.txns[0].shares9 === d9("5000") && f.txns[0].price9 === d9("12.50") && f.txns[0].sharesAfter9 === d9("25000"));
  check("clean P-buy: classified buy", classifyTxn(f, f.txns[0]).kind === "buy");
  check("clean P-buy: value 62500", txnValue9(f.txns[0]) === d9("62500"));
  check("clean P-buy: innocuous footnote kept, not excluding", f.footnotes["F1"]?.includes("weighted average") === true);

  const m = parseForm4(fx("m-exercise.xml"));
  const nd = m.txns.find((t) => t.table === "nonDerivative")!;
  const dv = m.txns.find((t) => t.table === "derivative")!;
  const ndc = classifyTxn(m, nd);
  check("M-exercise: non-deriv M/A excluded (code, not acquiredDisposed)",
    ndc.kind === "excluded" && (ndc as any).reason === "code:M");
  check("M-exercise: derivative row excluded by table", classifyTxn(m, dv).kind === "excluded");

  const cb = parseForm4(fx("tenb5-checkbox.xml"));
  check("10b5-1 checkbox parsed true (X0609)", cb.aff10b5One === true);
  const cbc = classifyTxn(cb, cb.txns[0]);
  check("10b5-1 checkbox excluded", cbc.kind === "excluded" && (cbc as any).reason === "10b5-1-checkbox");

  const fn = parseForm4(fx("tenb5-footnote.xml"));
  const fnc = classifyTxn(fn, fn.txns[0]);
  check("10b5-1 footnote excluded (no checkbox on X0409)", fn.aff10b5One === false
    && fnc.kind === "excluded" && (fnc as any).reason === "10b5-1-footnote");

  const dr = parseForm4(fx("drip-footnote.xml"));
  const drc = classifyTxn(dr, dr.txns[0]);
  check("DRIP footnote excluded", drc.kind === "excluded" && (drc as any).reason === "drip-espp-401k");

  const am = parseForm4(fx("form4a-amend.xml"));
  check("4/A parsed as amendment", am.documentType === "4/A" && am.txns[0].shares9 === d9("6000"));

  // Joint filing: one purchase, several reportingOwners — attribute to the human decision-maker.
  const joint = parseForm4(`<ownershipDocument><documentType>4</documentType>
    <issuer><issuerCik>0000123</issuerCik><issuerName>J</issuerName><issuerTradingSymbol>JNT</issuerTradingSymbol></issuer>
    <reportingOwner><reportingOwnerId><rptOwnerCik>111</rptOwnerCik><rptOwnerName>Big Fund LP</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>
    <reportingOwner><reportingOwnerId><rptOwnerCik>222</rptOwnerCik><rptOwnerName>Human Officer</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isOfficer>true</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
    </ownershipDocument>`);
  check("joint filing attributes to the officer, not the vehicle", primaryOwner(joint)?.cik === "222");
}

// ---------- store + 4/A supersede ----------
{
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  const r1 = storeForm4(db, "acc-1", parseForm4(fx("p-buy-clean.xml")), "2026-08-07T18:00:00-04:00");
  check("store clean buy: 1 row, 1 qualifying", r1.inserted === 1 && r1.qualifyingBuys === 1 && r1.symbol === "KVHI");
  check("store idempotent (replayed accession no-ops)", storeForm4(db, "acc-1", parseForm4(fx("p-buy-clean.xml")), null).inserted === 0);
  const r2 = storeForm4(db, "acc-2", parseForm4(fx("m-exercise.xml")), null);
  check("M-exercise stored but 0 qualifying", r2.inserted === 2 && r2.qualifyingBuys === 0);
  check("10b5-1 checkbox stored, 0 qualifying", storeForm4(db, "acc-3", parseForm4(fx("tenb5-checkbox.xml")), null).qualifyingBuys === 0);
  check("10b5-1 footnote stored, 0 qualifying", storeForm4(db, "acc-4", parseForm4(fx("tenb5-footnote.xml")), null).qualifyingBuys === 0);
  check("DRIP stored, 0 qualifying", storeForm4(db, "acc-5", parseForm4(fx("drip-footnote.xml")), null).qualifyingBuys === 0);

  let buys = qualifiedBuyEvents(db, { symbol: "KVHI" });
  check("only the clean P-buy qualifies", buys.length === 1 && buys[0].shares9 === d9("5000") && buys[0].value9 === d9("62500"));

  const ra = storeForm4(db, "acc-6", parseForm4(fx("form4a-amend.xml")), null);
  check("4/A supersedes original by transaction key", ra.superseded === 1);
  buys = qualifiedBuyEvents(db, { symbol: "KVHI" });
  check("post-amendment: ONE live buy with amended numbers", buys.length === 1
    && buys[0].shares9 === d9("6000") && buys[0].value9 === d9("74400"), JSON.stringify(buys.map((b) => d9str(b.value9))));
}

// ---------- cluster engine: window edges ----------
{
  const b = (cik: string, date: string): BuyEvent => mkBuy({ cik, date, usd: 40000 });
  const in10 = detectClusters([b("1", "2026-08-01"), b("2", "2026-08-05"), b("3", "2026-08-10")], NO_HIST, CL);
  check("window: day 10 IN (10-calendar-day inclusive)", in10.length === 1 && in10[0].participants.length === 3
    && in10[0].windowStart === "2026-08-01" && in10[0].windowEnd === "2026-08-10");
  const out11 = detectClusters([b("1", "2026-08-01"), b("2", "2026-08-05"), b("3", "2026-08-11")], NO_HIST, CL);
  check("window: day 11 OUT", out11.length === 0);
  check("dayDiff sanity", dayDiff("2026-08-01", "2026-08-10") === 9 && dayDiff("2026-08-01", "2026-08-11") === 10);
  const wide = detectClusters([b("1", "2026-08-01"), b("2", "2026-08-03"), b("3", "2026-08-05"), b("4", "2026-08-08")], NO_HIST, CL);
  check("overlapping windows collapse to ONE cluster (episode dedupe)", wide.length === 1 && wide[0].participants.length === 4);
}

// ---------- cluster engine: distinct CIKs + $ thresholds ----------
{
  const two = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 60000 }),
    mkBuy({ cik: "1", date: "2026-08-03", usd: 60000 }),
    mkBuy({ cik: "2", date: "2026-08-05", usd: 60000 }),
  ], NO_HIST, CL);
  check("3-distinct-CIK rule: 2 CIKs never cluster", two.length === 0);

  const under = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 50000 }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 45000 }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 9999 }),
  ], NO_HIST, CL);
  check("$10k per-insider floor: $9,999 insider doesn't count", under.length === 0);
  const atMin = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 50000 }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 45000 }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 10000 }),
  ], NO_HIST, CL);
  check("$10k exactly qualifies (≥)", atMin.length === 1 && atMin[0].participants.length === 3);

  const agg99 = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 33000 }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 33000 }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 33000 }),
  ], NO_HIST, CL);
  check("$100k aggregate floor: $99k fails", agg99.length === 0);
  const agg101 = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 34000 }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 34000 }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 33000 }),
  ], NO_HIST, CL);
  check("$101k aggregate passes", agg101.length === 1 && agg101[0].aggregate9 === d9("101000"));

  // Per-insider SUM within window clears the bar even when each fill is small.
  const summed = evaluateWindow([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 6000 }),
    mkBuy({ cik: "1", date: "2026-08-02", usd: 6000 }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 50000 }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 50000 }),
  ], NO_HIST, CL);
  check("per-insider $ aggregates across fills in window", summed.qualifies && summed.participants.length === 3);
}

// ---------- cluster engine: role gate ----------
{
  const officer1 = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 40000, officer: true, title: "VP Engineering" }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 40000, officer: false }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 40000, officer: false }),
  ], NO_HIST, CL);
  check("role gate: 1 officer + 2 others OK", officer1.length === 1);

  const dir2 = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 40000, officer: false, director: true }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 40000, officer: false, director: true }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 40000, officer: false }),
  ], NO_HIST, CL);
  check("role gate: 2 directors OK (no officer)", dir2.length === 1);

  const dir1 = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 40000, officer: false, director: true }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 40000, officer: false }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 40000, officer: false }),
  ], NO_HIST, CL);
  check("role gate: 1 director + no officer FAILS", dir1.length === 0);

  const owners2 = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 40000, officer: true, title: "CEO" }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 40000, officer: false, tenPct: true, name: "Alpha Capital LP" }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 40000, officer: false, tenPct: true, name: "Beta Fund LLC" }),
  ], NO_HIST, CL);
  check("role gate: 2 pure 10%-owner entities FAIL (<2 non-owner participants)", owners2.length === 0);
  check("isPureOwnerEntity: fund-shaped name without 10% flag still an entity",
    isPureOwnerEntity({ isOfficer: false, isDirector: false, isTenPercentOwner: false, name: "Gamma Partners LP" }));
  check("isPureOwnerEntity: a director never is", !isPureOwnerEntity({ isOfficer: false, isDirector: true, isTenPercentOwner: true, name: "Delta Fund LLC" }));
}

// ---------- cluster engine: routine-buyer screen ----------
{
  check("routine: same month 3 prior years", isRoutineBuyer("2026-08-05", ["2023-08-10", "2024-08-12", "2025-08-01"]));
  check("routine: only 2 prior years is NOT routine", !isRoutineBuyer("2026-08-05", ["2024-08-12", "2025-08-01"]));
  check("routine: different months not routine", !isRoutineBuyer("2026-08-05", ["2023-07-10", "2024-08-12", "2025-08-01"]));

  const hist = (cik: string): string[] => (cik === "1" ? ["2023-08-10", "2024-08-12", "2025-08-01"] : []);
  const dropped = detectClusters([
    mkBuy({ cik: "1", date: "2026-08-01", usd: 40000 }),
    mkBuy({ cik: "2", date: "2026-08-02", usd: 40000 }),
    mkBuy({ cik: "3", date: "2026-08-03", usd: 40000 }),
  ], hist, CL);
  check("routine insider dropped → cluster dies (2 left)", dropped.length === 0);
}

// ---------- scoring: role order + first-ever tiebreak ----------
{
  const agg = d9("120000");
  const base = [mkPart({ cik: "2", officer: true, title: "VP Sales" }), mkPart({ cik: "3", director: true })];
  const sCfo = scoreCluster([mkPart({ cik: "1", officer: true, title: "Chief Financial Officer" }), ...base], agg, CL);
  const sCeo = scoreCluster([mkPart({ cik: "1", officer: true, title: "Chief Executive Officer" }), ...base], agg, CL);
  const sOff = scoreCluster([mkPart({ cik: "1", officer: true, title: "VP Engineering" }), ...base], agg, CL);
  check("scoring: CFO > CEO > officer", sCfo > sCeo && sCeo > sOff, `${sCfo} ${sCeo} ${sOff}`);
  const sTie = scoreCluster([mkPart({ cik: "1", officer: true, title: "VP Engineering", firstEver: true }), ...base], agg, CL);
  check("scoring: first-ever bonus tips a tie", sTie > sOff);
  const sBig = scoreCluster([mkPart({ cik: "1", officer: true, title: "VP Engineering" }), ...base], d9("1200000"), CL);
  check("scoring: log10 size points (10× aggregate = +1)", near(sBig - sOff, 1, 1e-9), String(sBig - sOff));
}

// ---------- capacity: slots clamp + slot notional ----------
{
  check("slots: $1k sleeve → 2", slotCount(1000, CAP) === 2);
  check("slots: $2k sleeve → 4", slotCount(2000, CAP) === 4);
  check("slots: $4k sleeve → 8", slotCount(4000, CAP) === 8);
  check("slots: $10k sleeve clamps at 8", slotCount(10000, CAP) === 8);
  check("slots: $600 sleeve clamps at 2 (floor)", slotCount(600, CAP) === 2);
  check("slot notional: $1k/2 = $500", slotNotional9(1000, CAP) === d9("500"));
  check("slot notional: $400 sleeve floors at $300", slotNotional9(400, CAP) === d9("300"));
  check("slot notional: $6k sleeve ceils at $600", slotNotional9(6000, CAP) === d9("600"));
}

// ---------- liquidity floor + spread gate ----------
{
  check("median $vol: 25 bars @ $10×30k = exactly $300k (passes ≥)",
    medianDollarVolume9(mkBars(25, "10", "30000")) === d9("300000"));
  check("median $vol: short history → null", medianDollarVolume9(mkBars(10, "10", "30000")) === null);
  check("spread: 0.2% passes", spreadOk(d9("9.99"), d9("10.01"), LIQ.maxSpreadPct));
  check("spread: exactly 1.5% passes (≤)", spreadOk(d9("9.925"), d9("10.075"), LIQ.maxSpreadPct));
  check("spread: 2% fails", !spreadOk(d9("9.9"), d9("10.1"), LIQ.maxSpreadPct));
  check("spread: crossed quote fails", !spreadOk(d9("10.1"), d9("10"), LIQ.maxSpreadPct));

  const ok = passesLiquidityFloor({ bars: mkBars(25, "10", "30000"), price9: d9("10"), marketCap9: d9("100000000"), exchange: "NASDAQ" }, LIQ);
  check("floor: all gates pass", ok.ok);
  const lowVol = passesLiquidityFloor({ bars: mkBars(25, "10", "20000"), price9: d9("10"), marketCap9: d9("100000000"), exchange: "NASDAQ" }, LIQ);
  check("floor: $200k median fails", !lowVol.ok && (lowVol as any).reason === "LIQUIDITY_DOLLAR_VOL");
  const lowPx = passesLiquidityFloor({ bars: mkBars(25, "1.5", "300000"), price9: d9("1.5"), marketCap9: d9("100000000"), exchange: "NASDAQ" }, LIQ);
  check("floor: $1.50 price fails", !lowPx.ok && (lowPx as any).reason === "LIQUIDITY_PRICE");
  const noCap = passesLiquidityFloor({ bars: mkBars(25, "10", "30000"), price9: d9("10"), marketCap9: null, exchange: "NASDAQ" }, LIQ);
  check("floor: unknown market cap fails CLOSED", !noCap.ok && (noCap as any).reason === "LIQUIDITY_MARKET_CAP");
  const otc = passesLiquidityFloor({ bars: mkBars(25, "10", "30000"), price9: d9("10"), marketCap9: d9("100000000"), exchange: "OTC" }, LIQ);
  check("floor: OTC fails exchange-listed", !otc.ok && (otc as any).reason === "LIQUIDITY_NOT_LISTED");
}

// ---------- planner: decideEntries gates ----------
{
  // One-per-ticker.
  const dHeld = decideEntries([mkSnap("AAA", 5)], [{ symbol: "AAA", sector: "Tech" }], 2000, CAP, LIQ);
  check("one-per-ticker: held symbol → shadow ALREADY_HELD",
    dHeld[0].kind === "shadow" && (dHeld[0] as any).reason === "ALREADY_HELD");

  // Sector cap (≤2 same sector) — third Tech blocked, Health fine.
  const held2 = [{ symbol: "H1", sector: "Tech" }, { symbol: "H2", sector: "Tech" }];
  const dSec = decideEntries([mkSnap("BBB", 5), mkSnap("CCC", 4, { sector: "Health" })], held2, 2000, CAP, LIQ);
  const bbb = dSec.find((d) => d.symbol === "BBB")!;
  const ccc = dSec.find((d) => d.symbol === "CCC")!;
  check("sector cap: 3rd Tech → SECTOR_CAP", bbb.kind === "shadow" && (bbb as any).reason === "SECTOR_CAP");
  check("sector cap: other sector funds", ccc.kind === "fund");

  // Liquidity + spread route to shadow with the exact reason.
  const dLiq = decideEntries([mkSnap("DDD", 5, { bars: mkBars(25, "1.5", "300000"), quote: { bid9: d9("1.49"), ask9: d9("1.51") } })], [], 2000, CAP, LIQ);
  check("liquidity fail → shadow with floor reason", dLiq[0].kind === "shadow" && (dLiq[0] as any).reason === "LIQUIDITY_PRICE");
  const dSpr = decideEntries([mkSnap("EEE", 5, { quote: { bid9: d9("9.9"), ask9: d9("10.1") } })], [], 2000, CAP, LIQ);
  check("spread fail → shadow SPREAD_GATE", dSpr[0].kind === "shadow" && (dSpr[0] as any).reason === "SPREAD_GATE");
  const dNoQ = decideEntries([mkSnap("FFF", 5, { quote: null })], [], 2000, CAP, LIQ);
  check("missing quote → SPREAD_GATE (fail closed)", dNoQ[0].kind === "shadow" && (dNoQ[0] as any).reason === "SPREAD_GATE");

  // Full slots: $1k → 2 slots; best two scores fund, third shadows; a gate-failing candidate
  // must NOT consume a slot. Distinct sectors so the sector cap can't fire first.
  const dFull = decideEntries([mkSnap("S3", 3, { sector: "Energy" }), mkSnap("S5", 5), mkSnap("S4", 4, { sector: "Health" })], [], 1000, CAP, LIQ);
  check("selection: highest scores fund first",
    dFull.find((d) => d.symbol === "S5")!.kind === "fund" && dFull.find((d) => d.symbol === "S4")!.kind === "fund");
  const s3 = dFull.find((d) => d.symbol === "S3")!;
  check("full slots → shadow FULL_SLOTS", s3.kind === "shadow" && (s3 as any).reason === "FULL_SLOTS");
  const dNoBurn = decideEntries([mkSnap("BAD", 9, { quote: { bid9: d9("9"), ask9: d9("11") } }), mkSnap("OK1", 2), mkSnap("OK2", 1)], [], 1000, CAP, LIQ);
  check("gate-failing candidate doesn't burn a slot",
    dNoBurn.filter((d) => d.kind !== "shadow").length === 2);

  // Fractionable fallback.
  const dWhole = decideEntries([mkSnap("GGG", 5, { asset: { fractionable: false, exchange: "NYSE", tradable: true } })], [], 1000, CAP, LIQ);
  check("not fractionable → whole-share limit-at-mid ($500/$10 = 50 sh)",
    dWhole[0].kind === "fund-whole" && (dWhole[0] as any).qty9 === d9("50") && (dWhole[0] as any).limitPrice9 === d9("10"));
  const dSkip = decideEntries([mkSnap("HHH", 5, {
    bars: mkBars(25, "700", "1000"),
    quote: { bid9: d9("699"), ask9: d9("701") },
    asset: { fractionable: false, exchange: "NYSE", tradable: true },
  })], [], 1000, CAP, LIQ);
  check("not fractionable + slot < 1 share → SKIP_NOT_FRACTIONABLE",
    dSkip[0].kind === "shadow" && (dSkip[0] as any).reason === "SKIP_NOT_FRACTIONABLE");
  check("mid9 helper", mid9({ bid9: d9("9.99"), ask9: d9("10.01") }) === d9("10"));
}

// ---------- planner: executeEntries through THE gateway + shadow book rows ----------
await (async () => {
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  seedBook(db, "5000", "2026-08-11");
  const broker = mockBroker();
  const cA = mkCluster("SYMA", 5, "ins:SYMA:2026-08-10");
  const cB = mkCluster("SYMB", 4, "ins:SYMB:2026-08-10");
  const decisions: EntryDecision[] = [
    { kind: "fund", symbol: "SYMA", clusterId: cA.clusterId, sector: "Tech", notional9: d9("500"), estPrice9: d9("10") },
    { kind: "shadow", symbol: "SYMB", clusterId: cB.clusterId, reason: "FULL_SLOTS" },
  ];
  const res = await executeEntries(db, broker, {
    clusters: [cA, cB], decisions, signalDate: "2026-08-10", entryDate: "2026-08-11",
    configVersion: eff.version, washBlacklistDays: WBL, horizonTradingDays: EXITCFG.horizonTradingDays,
    clusterResetMaxMonths: EXITCFG.clusterResetMaxMonths, benchEntryPx9: d9("200"),
  });
  check("funded entry placed via gateway with ins coid",
    res[0].outcome === "placed" && broker.submits[0].client_order_id === "ins:SYMA:buy:20260811:01"
    && broker.submits[0].notional === "500" && broker.submits[0].side === "buy");
  const sigA = db.prepare("SELECT * FROM ins_signals WHERE cluster_id=?").get(cA.clusterId) as any;
  const sigB = db.prepare("SELECT * FROM ins_signals WHERE cluster_id=?").get(cB.clusterId) as any;
  check("shadow book: funded row with entry/bench px", sigA.funded === 1 && sigA.entry_px9 === "10" && sigA.bench_entry_px9 === "200");
  check("shadow book: EVERY qualifying signal logged (unfunded too)", sigB.funded === 0 && sigB.skip_reason === "FULL_SLOTS");
  const meta = readMeta(db, "SYMA");
  check("position_meta written: horizon + 9-month cap", meta !== null && meta.horizonTradingDays === EXITCFG.horizonTradingDays
    && meta.maxExitDate === addMonths("2026-08-11", EXITCFG.clusterResetMaxMonths) && meta.clockResets === 0);
  check("cluster row persisted", getCluster(db, cA.clusterId)?.status === "active");

  // Clock reset: a NEW cluster on a held name resets once — and only once.
  const c2 = mkCluster("SYMA", 4, "ins:SYMA:2026-09-20");
  const res2 = await executeEntries(db, broker, {
    clusters: [c2], decisions: [{ kind: "shadow", symbol: "SYMA", clusterId: c2.clusterId, reason: "ALREADY_HELD" }],
    signalDate: "2026-09-20", entryDate: "2026-09-21", configVersion: eff.version, washBlacklistDays: WBL,
    horizonTradingDays: EXITCFG.horizonTradingDays, clusterResetMaxMonths: EXITCFG.clusterResetMaxMonths, benchEntryPx9: null,
  });
  const metaR = readMeta(db, "SYMA")!;
  check("new cluster mid-hold → clock reset once", res2[0].outcome === "clock-reset" && metaR.clockResets === 1 && metaR.resetDate === "2026-09-21");
  const c3 = mkCluster("SYMA", 4, "ins:SYMA:2026-10-05");
  const res3 = await executeEntries(db, broker, {
    clusters: [c3], decisions: [{ kind: "shadow", symbol: "SYMA", clusterId: c3.clusterId, reason: "ALREADY_HELD" }],
    signalDate: "2026-10-05", entryDate: "2026-10-06", configVersion: eff.version, washBlacklistDays: WBL,
    horizonTradingDays: EXITCFG.horizonTradingDays, clusterResetMaxMonths: EXITCFG.clusterResetMaxMonths, benchEntryPx9: null,
  });
  check("second reset REFUSED (max one)", res3[0].outcome === "shadow" && readMeta(db, "SYMA")!.clockResets === 1
    && readMeta(db, "SYMA")!.resetDate === "2026-09-21");
})();

// ---------- exits: horizon + reset anchor + 9-month cap ----------
{
  const S = genSessions("2026-01-05", 200);
  const meta: InsPositionMeta = {
    clusterId: "c", entryDate: S[0], horizonTradingDays: EXITCFG.horizonTradingDays, clockResets: 0,
    maxExitDate: addMonths(S[0], EXITCFG.clusterResetMaxMonths), sector: null, participants: [],
  };
  check("horizon: 125 sessions held → not due", !horizonDue(meta, S, S[125]));
  check("horizon: 126 sessions held → due", horizonDue(meta, S, S[126]));
  check("horizon: reset re-anchors the clock", !horizonDue({ ...meta, resetDate: S[50] }, S, S[126]));
  check("horizon: 9-month calendar cap fires regardless", horizonDue({ ...meta, horizonTradingDays: 99999 }, S, meta.maxExitDate));
  check("addMonths: day-clamped", addMonths("2026-05-31", 9) === "2027-02-28" && addMonths("2026-08-11", 9) === "2027-05-11");

  const resetOk = tryClockReset(meta, "2026-03-01");
  check("clock reset: first allowed", resetOk !== null && resetOk.clockResets === 1 && resetOk.resetDate === "2026-03-01");
  check("clock reset: second refused", tryClockReset(resetOk!, "2026-04-01") === null);
  check("clock reset: refused at/past 9-month cap", tryClockReset(meta, meta.maxExitDate) === null);
}

// ---------- exits: reversal detection ----------
{
  const parts = [{ cik: "1", shares9: "1000" }, { cik: "2", shares9: "1000" }, { cik: "3", shares9: "1000" }];
  check("reversal: 2 participant sellers trigger",
    detectReversal(parts, [{ ownerCik: "1", shares9: d9("100") }, { ownerCik: "2", shares9: d9("50") }], EXITCFG).triggered);
  check("reversal: one seller >50% of cluster shares triggers",
    detectReversal(parts, [{ ownerCik: "1", shares9: d9("501") }], EXITCFG).triggered);
  check("reversal: exactly 50% by one seller does NOT trigger",
    !detectReversal(parts, [{ ownerCik: "1", shares9: d9("500") }], EXITCFG).triggered);
  check("reversal: non-participant sellers ignored",
    !detectReversal(parts, [{ ownerCik: "9", shares9: d9("5000") }], EXITCFG).triggered);
}

// ---------- exits: horizon sell through the gateway ----------
await (async () => {
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  seedBook(db, "5000", "2026-01-05");
  ingestFill(db, { id: "x1", symbol: "SYMX", side: "buy", qty9: d9("10"), price9: d9("10"), ts: "2026-01-05T15:00:00Z", sleeve: "ins" });
  writeMeta(db, "SYMX", {
    clusterId: "ins:SYMX:2026-01-02", entryDate: "2026-01-05", horizonTradingDays: EXITCFG.horizonTradingDays,
    clockResets: 0, maxExitDate: addMonths("2026-01-05", EXITCFG.clusterResetMaxMonths), sector: null,
    participants: [{ cik: "1", name: "P", shares9: "1000" }],
  });
  const S = genSessions("2026-01-05", 200);
  const broker = mockBroker();
  const actions = await runExits(db, broker, {
    exit: EXITCFG, washBlacklistDays: WBL, configVersion: "t", asOfDate: S[126], sessions: S,
    latestPrice9: async () => d9("11"),
  });
  check("horizon exit at 126 trading days: market sell of full position",
    actions[0].action === "sell-horizon" && actions[0].place?.placed === true
    && broker.submits[0].side === "sell" && broker.submits[0].qty === "10"
    && broker.submits[0].client_order_id?.startsWith("ins:SYMX:sell:") === true);
})();

// ---------- exits: reversal sell from later filings ----------
await (async () => {
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  seedBook(db, "5000", "2026-01-05");
  ingestFill(db, { id: "r1", symbol: "SYMR", side: "buy", qty9: d9("10"), price9: d9("10"), ts: "2026-01-05T15:00:00Z", sleeve: "ins" });
  writeMeta(db, "SYMR", {
    clusterId: "ins:SYMR:2026-01-02", entryDate: "2026-01-05", horizonTradingDays: EXITCFG.horizonTradingDays,
    clockResets: 0, maxExitDate: addMonths("2026-01-05", EXITCFG.clusterResetMaxMonths), sector: null,
    participants: [{ cik: "5555555", name: "Garcia", shares9: "1000" }, { cik: "4444444", name: "Nguyen", shares9: "1000" }],
  });
  // Garcia dumps 600 of his 1000 cluster shares (>50%) — stored like any later filing would be.
  storeForm4(db, "sell-1", mkParsed({ cik: "5555555", name: "Garcia Miguel", officer: true, date: "2026-01-20", code: "S", ad: "D", shares: "600", price: "9", symbol: "SYMR" }), null);
  check("participantSells sees the open-market S",
    participantSells(db, "SYMR", "2026-01-05", ["5555555", "4444444"]).length === 1);
  const S = genSessions("2026-01-05", 60);
  const broker = mockBroker();
  const actions = await runExits(db, broker, {
    exit: EXITCFG, washBlacklistDays: WBL, configVersion: "t", asOfDate: S[10], sessions: S,
    latestPrice9: async () => d9("9"),
  });
  check("reversal trigger sells (single >50% seller)", actions[0].action === "sell-reversal" && broker.submits.length === 1);
})();

// ---------- exits: ATR stop fires an EVENT, never a sell ----------
await (async () => {
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  seedBook(db, "5000", "2026-01-05");
  ingestFill(db, { id: "s1", symbol: "SYMS", side: "buy", qty9: d9("10"), price9: d9("10"), ts: "2026-01-05T15:00:00Z", sleeve: "ins" });
  writeMeta(db, "SYMS", {
    clusterId: "ins:SYMS:2026-01-02", entryDate: "2026-01-05", horizonTradingDays: EXITCFG.horizonTradingDays,
    clockResets: 0, maxExitDate: addMonths("2026-01-05", EXITCFG.clusterResetMaxMonths), sector: null,
    participants: [{ cik: "1", name: "P", shares9: "1000" }],
  });
  // 15 flat closes at 10, then 15 stairs down to 2.5 → ATR(14) ≈ 0.5, trailing stop ≈ 8.75, last 2.5.
  const dates = genSessions("2026-01-01", 30);
  const closes = dates.map((date, i) => ({ date, close9: d9(i < 15 ? "10" : (10 - (i - 14) * 0.5).toFixed(1)), volume9: d9("1000") }));
  const stop = atrStopLevel9(closes, "2026-01-05", 14, 2.5);
  check("ATR stop level computed below the high", stop !== null && stop > 0n && stop < d9("10"));
  const S = genSessions("2026-01-05", 60);
  const broker = mockBroker();
  const a1 = await runExits(db, broker, {
    exit: EXITCFG, washBlacklistDays: WBL, configVersion: "t", asOfDate: S[10], sessions: S,
    latestPrice9: async () => d9("2.5"), bars: async () => closes, atr: { days: 14, multiple: 2.5 },
  });
  check("stop fires: event emitted, NO order placed", a1[0].action === "stop-fired" && broker.submits.length === 0);
  check("stop event in state for the judgment layer", getState(db, "ins:stop_fired:SYMS") !== null);
  check("stop event stamped in position_meta", readMeta(db, "SYMS")!.stopFired !== undefined);
  const a2 = await runExits(db, broker, {
    exit: EXITCFG, washBlacklistDays: WBL, configVersion: "t", asOfDate: S[11], sessions: S,
    latestPrice9: async () => d9("2.5"), bars: async () => closes, atr: { days: 14, multiple: 2.5 },
  });
  check("stop emits once (already-flagged after)", a2[0].action === "stop-fired" && a2[0].detail === "already-flagged");
})();

// ---------- amendment kills cluster → thesis-review flag (never auto-sell) ----------
await (async () => {
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  storeForm4(db, "a1", parseForm4(fx("p-buy-clean.xml")), null);                                     // Jane CFO $62.5k 8/6
  storeForm4(db, "a2", mkParsed({ cik: "5555555", name: "Garcia Miguel", officer: true, title: "President", date: "2026-08-04", shares: "3300", price: "12.35" }), null); // $40,755
  storeForm4(db, "a3", mkParsed({ cik: "4444444", name: "Nguyen Alice", director: true, date: "2026-08-05", shares: "3300", price: "12.20" }), null);                     // $40,260
  const clusters = detectClusters(qualifiedBuyEvents(db, { symbol: "KVHI" }), ownerHistoryFn(db, "1111111", "2026-08-04"), CL);
  check("real-filing cluster detected (3 insiders, KVHI)", clusters.length === 1 && clusters[0].participants.length === 3
    && clusters[0].clusterId === "ins:KVHI:2026-08-06");
  upsertCluster(db, clusters[0], eff.version);
  ingestFill(db, { id: "kf1", symbol: "KVHI", side: "buy", qty9: d9("40"), price9: d9("12.5"), ts: "2026-08-11T13:30:00Z", sleeve: "ins" });
  writeMeta(db, "KVHI", {
    clusterId: clusters[0].clusterId, entryDate: "2026-08-11", horizonTradingDays: EXITCFG.horizonTradingDays,
    clockResets: 0, maxExitDate: addMonths("2026-08-11", EXITCFG.clusterResetMaxMonths), sector: null,
    participants: clusters[0].participants.map((p) => ({ cik: p.cik, name: p.name, shares9: p.shares9 })),
  });

  // Jane's 4/A restates the buy at 100 shares ($1,240 — under the $10k floor) → cluster dies.
  const amendXml = fx("form4a-amend.xml").replace(">6000<", ">100<");
  const port: EdgarPort = {
    getCurrentForm4Atom: async () => fx("atom-getcurrent.xml"),
    getDailyIndex: async () => fx("daily-index.idx"),
    getFiling: async () => amendXml,
  };
  const res = await processAccession(db, port, { accession: "amend-1", formType: "4/A", cik: "1111111" }, "test", CL);
  check("4/A processed: supersedes + re-qualifies", res.status === "processed" && res.superseded === 1
    && (res.deadClusters ?? []).includes(clusters[0].clusterId));
  check("cluster marked dead", getCluster(db, clusters[0].clusterId)?.status === "dead");
  const appr = db.prepare("SELECT * FROM approvals WHERE kind='ins-thesis-review' AND status='pending'").all() as any[];
  check("thesis-review approval raised for the live position", appr.length === 1 && JSON.parse(appr[0].payload).symbol === "KVHI");
  check("meta flagged, position NOT auto-sold", readMeta(db, "KVHI")!.thesisReview !== undefined);
  check("requalify is idempotent-ish (already dead)", requalifyCluster(db, clusters[0].clusterId, CL) === "dead");

  // And runExits leaves a thesis-review position alone.
  const broker = mockBroker();
  const S = genSessions("2026-08-11", 40);
  const actions = await runExits(db, broker, {
    exit: EXITCFG, washBlacklistDays: WBL, configVersion: "t", asOfDate: S[5], sessions: S,
    latestPrice9: async () => d9("12"),
  });
  check("thesis-review position held for the judgment layer", actions[0].action === "hold" && broker.submits.length === 0);
})();

// ---------- shadow book: CAR vs IWM ----------
await (async () => {
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  const c = mkCluster("TT1", 3, "ins:TT1:2026-01-02");
  check("shadow: signal recorded once", recordSignal(db, c, "2026-01-02") === true);
  check("shadow: re-detection doesn't double-count", recordSignal(db, c, "2026-01-02") === false);
  markFunded(db, c.clusterId, { entryDate: "2026-01-05", slotNotional9: d9("500"), entryPx9: d9("10"), benchEntryPx9: d9("100") });

  const S = genSessions("2026-01-05", 200);
  const symCloses = S.map((date, i) => ({ date, close9: d9(i === 21 ? "11" : i === 63 ? "12" : i === 126 ? "9" : "10") }));
  const benchCloses = S.map((date, i) => ({ date, close9: d9(i === 21 ? "102" : i === 63 ? "104" : i === 126 ? "95" : "100") }));
  check("CAR21: +10% vs +2% → +8%", near(computeCar(symCloses, benchCloses, "2026-01-05", d9("10"), d9("100"), 21), 0.08));
  check("CAR63: +20% vs +4% → +16%", near(computeCar(symCloses, benchCloses, "2026-01-05", d9("10"), d9("100"), 63), 0.16));
  check("CAR126: −10% vs −5% → −5%", near(computeCar(symCloses, benchCloses, "2026-01-05", d9("10"), d9("100"), 126), -0.05));
  check("CAR before horizon → null (never early)", computeCar(symCloses.slice(0, 10), benchCloses, "2026-01-05", d9("10"), d9("100"), 21) === null);

  check("bench symbol comes from config", BENCH === "IWM");
  const prices: PricePort = { getCloses: async (sym) => (sym === BENCH ? benchCloses : symCloses) };
  const touched = await updateShadowCars(db, prices, BENCH, S[199]);
  const row = db.prepare("SELECT * FROM ins_signals WHERE cluster_id=?").get(c.clusterId) as any;
  check("updateShadowCars fills all horizons", touched === 1 && near(row.car21, 0.08) && near(row.car63, 0.16) && near(row.car126, -0.05));
  check("updateShadowCars idempotent", (await updateShadowCars(db, prices, BENCH, S[199])) === 0);
})();

// ---------- ingestion: Atom + daily index parsing, poll cadence ----------
await (async () => {
  const entries = parseAtomForm4Entries(fx("atom-getcurrent.xml"));
  check("atom: 2 unique Form 4/4A entries (dup accession + form 3 dropped)", entries.length === 2);
  check("atom: accession/cik/type extracted", entries[0].accession === "0001111111-26-000101"
    && entries[0].formType === "4" && entries[0].cik === "1111111"
    && entries[1].accession === "0007777777-26-000055" && entries[1].formType === "4/A");

  const idx = parseDailyIndexForm4(fx("daily-index.idx"));
  check("daily index: dedupe by accession (rows repeat per filer)", idx.length === 3);
  check("daily index: 4 and 4/A only", idx.map((e) => e.accession).join(",") ===
    "0001111111-26-000101,0001111111-26-000102,0007777777-26-000055"
    && idx[2].formType === "4/A");

  check("poll window: weekday noon yes", shouldPollNow(2, "12:00"));
  check("poll window: weekend no", !shouldPollNow(6, "12:00") && !shouldPollNow(0, "12:00"));
  check("poll window: 05:59 no, 22:05 yes, 22:06 no",
    !shouldPollNow(3, "05:59") && shouldPollNow(3, "22:05") && !shouldPollNow(3, "22:06"));
  const delay = pollDelaySeconds(INS);
  check("poll delay within config band", delay >= INS.pollSecondsMin && delay <= INS.pollSecondsMax);

  check("daily index URL shape", dailyIndexUrl("2026-08-10") === "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260810.idx");
  check("accession path form", accessionNoDashes("0001111111-26-000101") === "000111111126000101");
  check("sector port stub returns null (Phase 4/5 must supply)", (await sectorPortStub.getSector("AAPL")) === null);

  // pollOnce + nightly reconcile against a fixture-fed port.
  const db = openDb(":memory:");
  ensureInsiderTables(db);
  const port: EdgarPort = {
    getCurrentForm4Atom: async () => fx("atom-getcurrent.xml"),
    getDailyIndex: async () => fx("daily-index.idx"),
    getFiling: async (acc) => {
      if (acc === "0001111111-26-000101") return fx("p-buy-clean.xml");
      if (acc === "0001111111-26-000102") return fx("tenb5-footnote.xml");
      throw new Error("404 test");
    },
  };
  const r1 = await pollOnce(db, port, CL);
  check("pollOnce: processes new, records errors", r1.length === 2
    && r1[0].status === "processed" && r1[0].qualifyingBuys === 1 && r1[1].status === "error");
  const r2 = await pollOnce(db, port, CL);
  check("pollOnce: processed skipped on re-poll, errors retried", r2[0].status === "skipped" && r2[1].status === "error");
  check("accession ledger: processed seen, errored retryable",
    accessionSeen(db, "0001111111-26-000101") && !accessionSeen(db, "0007777777-26-000055"));
  const rec = await reconcileDaily(db, port, "2026-08-10", CL);
  check("nightly reconcile: fetches only what the poll missed", rec.indexed === 3 && rec.missed === 2
    && rec.results.find((r) => r.accession === "0001111111-26-000102")?.status === "processed");
})();

// ---------- structural rail: this sleeve never reads buying_power ----------
{
  const dir = fileURLToPath(new URL("./v2/sleeves/insider/", import.meta.url));
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(dir + f, "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    if (/\.buying_power|\bbuying_power\s*[\]:]/.test(src) || /buyingPower/.test(src)) offenders.push(f);
  }
  check("no insider source reads buying_power", offenders.length === 0, offenders.join(","));
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 insider sleeve: all green");
