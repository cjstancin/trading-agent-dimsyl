// Offline tests — v2 momentum sleeve: 12-1 signal math, deterministic tiebreaks, quality vetoes,
// FIP re-rank, N schedule, hold band, weight band, min-order, deployScalar, vol brake, shadow
// books, universe snapshot + delta detector, execute() through a fake broker.
// Uses :memory: SQLite + injected fixture ports; no network, no env.
import { openDb, getState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { loadConfig, DEFAULTS_PATH } from "./v2/config.js";
import { seedBook } from "./v2/settled-cash.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";
import { ensureMomTables } from "./v2/sleeves/momentum/schema.js";
import {
  return12x1, fipScore, vetoReason, computeRanks, nFor, selectTargets,
  dailyReturns, vol20d, volBrakeActive, type SignalInput,
} from "./v2/sleeves/momentum/signal.js";
import { planRebalance, executeRebalance, hhmmToMinutes, type Holding } from "./v2/sleeves/momentum/planner.js";
import { snapshotUniverse, universeDeltaCheck, buildUniverse, type UniverseRow } from "./v2/sleeves/momentum/universe.js";
import { parseConstituentsHtml } from "./v2/sleeves/momentum/wikipedia.js";
import { extractFundamentals, encodeFacts, decodeFacts } from "./v2/sleeves/momentum/edgar.js";
import { runShadowMonth, compareBooks } from "./v2/sleeves/momentum/shadow.js";
import { runMonthEnd } from "./v2/sleeves/momentum/month-end.js";
import type { Fundamentals, MomentumConfig } from "./v2/sleeves/momentum/ports.js";
import {
  makeMonthCloses, makeCompanyFacts, cleanFundamentals, makeFixturePorts,
  WIKI_SP500_SAMPLE_HTML, type FixtureSymbol,
} from "./v2/sleeves/momentum/fixtures.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

// Committed defaults only (journal path pointed at a non-file so a future runtime amendment can
// never flip a unit test).
const eff = loadConfig(DEFAULTS_PATH, ":no-journal:");
const CFG = eff.config.momentum as MomentumConfig;

function input(symbol: string, over: Partial<SignalInput> = {}): SignalInput {
  return {
    symbol,
    closes: makeMonthCloses("2026-07", 100, Array(13).fill(0.01)).map((m) => m.close),
    dollarVolume: 1e6,
    pctPosDays: 0.5,
    pctNegDays: 0.4,
    fundamentals: cleanFundamentals(),
    sector: "Industrials",
    ...over,
  };
}

console.log("v2 momentum:");

// ---------- 12-1 return math ----------
{
  // 13 closes: base (idx0) = 100 … idx11 = 150, idx12 (latest month) jumps to 300 and must be SKIPPED.
  const closes = [100, 103, 106, 109, 112, 115, 118, 121, 124, 130, 140, 150, 300];
  check("12-1 skips the latest month", Math.abs(return12x1(closes, 12, 1) - 0.5) < 1e-12);
  // Longer history: only the last 13 matter.
  const padded = [1, 2, 3, ...closes];
  check("12-1 uses the last lookback+1 closes", Math.abs(return12x1(padded, 12, 1) - 0.5) < 1e-12);
  // Dividend adjustment lives in the closes themselves: an adjusted series (all closes scaled by
  // the same payout factor) yields the identical total return.
  const adjusted = closes.map((c) => c * 0.97);
  check("adjusted series → same total return", Math.abs(return12x1(adjusted, 12, 1) - return12x1(closes, 12, 1)) < 1e-12);
  let threw = false;
  try { return12x1([1, 2, 3], 12, 1); } catch { threw = true; }
  check("too-short history throws", threw);
}

// ---------- deterministic tiebreak ----------
{
  const sameCloses = makeMonthCloses("2026-07", 100, Array(13).fill(0.02)).map((m) => m.close);
  const res = computeRanks([
    input("BBB", { closes: sameCloses, dollarVolume: 100 }),
    input("AAA", { closes: sameCloses, dollarVolume: 100 }),
    input("CCC", { closes: sameCloses, dollarVolume: 999 }),
  ], CFG);
  check("tiebreak: dollar-volume DESC first", res.top[0].symbol === "CCC");
  check("tiebreak: then symbol ASC", res.top[1].symbol === "AAA" && res.top[2].symbol === "BBB");
}

// ---------- quality vetoes ----------
{
  const f = (over: Partial<Fundamentals>): Fundamentals => ({ ...cleanFundamentals(), ...over });
  check("clean name passes", vetoReason(cleanFundamentals(), "Industrials", CFG) === null);
  check("missing fundamentals object → veto", vetoReason(null, "Industrials", CFG) === "missing-fundamentals");
  check("veto 1: GP/A ≤ 0 AND op income < 0", vetoReason(f({ gpOverAssets: -0.01, ttmOpIncome: -5 }), "Industrials", CFG) === "unprofitable");
  check("GP/A ≤ 0 alone is NOT vetoed", vetoReason(f({ gpOverAssets: -0.01, ttmOpIncome: 5 }), "Industrials", CFG) === null);
  check("veto 2: accruals > +0.10", vetoReason(f({ accruals: CFG.vetoes.accrualsMax + 0.001 }), "Industrials", CFG) === "accruals");
  check("accruals at the limit passes", vetoReason(f({ accruals: CFG.vetoes.accrualsMax }), "Industrials", CFG) === null);
  check("veto 3: Debt/Assets > 0.70", vetoReason(f({ debtOverAssets: CFG.vetoes.debtAssetsMax + 0.01 }), "Industrials", CFG) === "leverage");
  check("debt veto skipped for Financials", vetoReason(f({ debtOverAssets: 0.95 }), "Financials", CFG) === null);
  check("debt veto skipped for Real Estate", vetoReason(f({ debtOverAssets: 0.95 }), "Real Estate", CFG) === null);
  check("missing accruals field → veto", vetoReason(f({ accruals: null }), "Industrials", CFG) === "missing-fundamentals");
  check("missing debt field → veto (non-financial)", vetoReason(f({ debtOverAssets: null }), "Industrials", CFG) === "missing-fundamentals");
  check("missing debt field ok for Financials", vetoReason(f({ debtOverAssets: null }), "Financials", CFG) === null);
}

// ---------- FIP re-rank ----------
{
  check("fip: smooth winner is negative", fipScore(0.4, 0.6, 0.35) < 0);
  check("fip: jumpy winner is positive", fipScore(0.4, 0.4, 0.55) > 0);
  const smooth = input("SMTH", { pctPosDays: 0.65, pctNegDays: 0.30, dollarVolume: 1 });
  const jumpy = input("JMPY", { pctPosDays: 0.40, pctNegDays: 0.55, dollarVolume: 999 });
  const res = computeRanks([jumpy, smooth], CFG);
  check("FIP re-rank puts the smooth mover first (despite lower dollar-volume)", res.final[0].symbol === "SMTH", JSON.stringify(res.final.map((r) => r.symbol)));
  check("final ranks are 1-based sequential", res.final[0].finalRank === 1 && res.final[1].finalRank === 2);
  // Vetoed names never reach the FIP stage.
  const dead = input("DEAD", { fundamentals: null });
  const res2 = computeRanks([dead, smooth], CFG);
  check("vetoed name excluded from final", res2.final.every((r) => r.symbol !== "DEAD") && res2.vetoed[0]?.symbol === "DEAD");
}

// ---------- N schedule (equity-indexed) ----------
{
  check("$2k → 10 names", nFor(CFG, 2000) === 10);
  check("$3,999 → 10 names", nFor(CFG, 3999) === 10);
  check("$4k → 15 names", nFor(CFG, 4000) === 15);
  check("$5k → 15 names", nFor(CFG, 5000) === 15);
  check("$10k → 20 names", nFor(CFG, 10000) === 20);
  check("$25k → 50 names", nFor(CFG, 25000) === 50);
}

// ---------- hold band ----------
{
  const ranked = Array.from({ length: 30 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`); // S01=rank1 …
  const held = ["S05", "S15", "S26", "GONE"]; // rank 5, 15, 26, unranked
  const sel = selectTargets(ranked, held, 10, CFG.rebalance.buyFromTop, CFG.rebalance.sellBelowRank);
  check("rank 5 held → keep", sel.keeps.includes("S05"));
  check("rank 15 held → keep (11–25 band)", sel.keeps.includes("S15"));
  check("rank 26 held → sell (below rank 25)", sel.sells.includes("S26"));
  check("unranked holding → sell (rank-out)", sel.sells.includes("GONE"));
  check("buys only from top 10", sel.buys.every((s) => ranked.indexOf(s) < CFG.rebalance.buyFromTop));
  check("buys fill open slots (10 − 2 keeps = 8)", sel.buys.length === 8);
  check("held names not re-bought", !sel.buys.includes("S05") && !sel.buys.includes("S15"));
  check("rank 25 held → keep (edge)", selectTargets(ranked, ["S25"], 10, 10, 25).keeps.includes("S25"));
  check("keeps already at N → no buys", selectTargets(ranked, ranked.slice(0, 10), 10, 10, 25).buys.length === 0);
}

// ---------- weight band + min order + deployScalar + vol brake (planner) ----------
{
  const ranked = Array.from({ length: 30 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`);
  const H = (qty: string, price: string): Holding => ({ qty9: d9(qty), price9: d9(price) });
  // Sleeve $2,000, N=10 → target $200/name; band 7.5–12.5% of sleeve = $150–$250.
  const holdings = new Map<string, Holding>([
    ["S01", H("2", "110")],   // $220 = 11% → inside band → NO trade
    ["S02", H("2", "130")],   // $260 = 13% → above → trim $60
    ["S03", H("1", "130")],   // $130 = 6.5% → below → add $70
    ["S26", H("1", "50")],    // rank 26 → rank-out sell (full qty)
  ]);
  const plan = planRebalance({ ranked, holdings, sleeveEquity9: d9("2000"), cfg: CFG });
  check("N resolved from equity ($2k → 10)", plan.n === 10);
  check("per-name target $200", d9str(plan.perName9) === "200");
  const bySym = <T extends { symbol: string }>(arr: T[], s: string): T | undefined => arr.find((o) => o.symbol === s);
  check("inside band (11%) → no trade", !bySym(plan.sells, "S01") && !bySym(plan.buys, "S01"));
  const trim = bySym(plan.sells, "S02");
  check("13% → band-trim $60 sell", trim?.reason === "band-trim" && d9str(trim!.notional9!) === "60");
  const add = bySym(plan.buys, "S03");
  check("6.5% → band-add $70 buy (unscaled)", add?.reason === "band-add" && d9str(add!.notional9!) === "70");
  const exit = bySym(plan.sells, "S26");
  check("rank-out sells full qty", exit?.reason === "rank-out" && d9str(exit!.qty9!) === "1");
  const newBuys = plan.buys.filter((o) => o.reason === "new-buy");
  check("new buys sized to $200 each", newBuys.length > 0 && newBuys.every((o) => d9str(o.notional9!) === "200"));
  check("new buys only from top 10 non-held", newBuys.every((o) => ranked.indexOf(o.symbol) < 10));

  // deployScalar 0.55 → new buys $110; band-add still $70 (NEW-BUY sizing only).
  const plan55 = planRebalance({ ranked, holdings, sleeveEquity9: d9("2000"), cfg: CFG, deployScalar: 0.55 });
  const nb55 = plan55.buys.filter((o) => o.reason === "new-buy");
  check("deployScalar 0.55 scales new buys to $110", nb55.length > 0 && nb55.every((o) => d9str(o.notional9!) === "110"));
  const add55 = plan55.buys.find((o) => o.reason === "band-add");
  check("deployScalar leaves band-adds unscaled", add55 != null && d9str(add55.notional9!) === "70");

  // Min-order: sleeve $800 → target $80, band $60–$100; $102 held → trim $22 < $25 → suppressed.
  const tiny = new Map<string, Holding>([["S01", H("1", "102")]]);
  const planMin = planRebalance({ ranked, holdings: tiny, sleeveEquity9: d9("800"), cfg: CFG });
  check("band-trim below $25 suppressed", !planMin.sells.some((o) => o.symbol === "S01"));
  check("suppression recorded in dropped", planMin.dropped.some((d) => d.order.symbol === "S01" && /min order/.test(d.why)));
  // Sleeve $200 → target $20/name < $25 → every new buy suppressed.
  const planAllTiny = planRebalance({ ranked, holdings: new Map(), sleeveEquity9: d9("200"), cfg: CFG });
  check("new buys below $25 all suppressed", planAllTiny.buys.length === 0 && planAllTiny.dropped.length === 10);

  // Vol brake: adds (band-add + new-buy) deferred; sells untouched.
  const planBrake = planRebalance({ ranked, holdings, sleeveEquity9: d9("2000"), cfg: CFG, volBrakeActive: true });
  check("vol brake defers all adds", planBrake.buys.length === 0 && planBrake.deferred.length > 0);
  check("vol brake leaves sells alone", planBrake.sells.length === plan.sells.length);
}

// ---------- vol brake math ----------
{
  const calm = Array.from({ length: 30 }, (_, i) => 100 + i * 0.05);          // ~5bp/day drift
  const wild = Array.from({ length: 30 }, (_, i) => 100 * (1 + (i % 2 === 0 ? 0.04 : -0.037) * 1)); // ±4% swings
  const calmRets = dailyReturns(calm);
  const wildRets = dailyReturns(wild);
  check("vol20d orders sanely", vol20d(wildRets) > vol20d(calmRets));
  check("brake trips at >2× SPY", volBrakeActive(wildRets, calmRets, CFG.localBrake.vol20dVsSpyMax));
  check("brake quiet when sleeve ≈ SPY", !volBrakeActive(calmRets, calmRets, CFG.localBrake.vol20dVsSpyMax));
  check("brake quiet on unknown vol", !volBrakeActive([], calmRets, CFG.localBrake.vol20dVsSpyMax));
}

// ---------- universe snapshot + delta detector ----------
{
  const db = openDb(":memory:");
  ensureMomTables(db);
  const rows = (syms: string[]): UniverseRow[] => syms.map((s) => ({ symbol: s, sector: "Industrials", cik: null, list: "sp500" as const }));
  const july = Array.from({ length: 20 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`);
  const r1 = snapshotUniverse(db, "2026-07", rows(july));
  check("snapshot persists all rows", r1.total === 20);
  const r2 = snapshotUniverse(db, "2026-07", rows(july));
  check("snapshot re-run idempotent", r2.total === 20);
  check("first month has no baseline → no alert", !universeDeltaCheck(db, "2026-07", CFG).alerted);

  // August: 5 dropped, 5 new → delta 10/20 = 50% > 15%.
  const august = [...july.slice(0, 15), "N01", "N02", "N03", "N04", "N05"];
  snapshotUniverse(db, "2026-08", rows(august));
  const delta = universeDeltaCheck(db, "2026-08", CFG);
  check("delta computed (50%)", Math.abs(delta.deltaPct - 50) < 1e-9, String(delta.deltaPct));
  check("over-threshold delta alerted", delta.alerted);
  const appr = db.prepare("SELECT kind, status, payload FROM approvals WHERE kind='mom-universe-delta'").all() as any[];
  check("one pending approvals row filed", appr.length === 1 && appr[0].status === "pending");
  check("payload carries the evidence", /2026-08/.test(appr[0].payload) && /N01/.test(appr[0].payload));
  universeDeltaCheck(db, "2026-08", CFG);
  const appr2 = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='mom-universe-delta'").get() as { n: number };
  check("re-run does not spam the queue", Number(appr2.n) === 1);

  // September: small drift (1 change of 20 = 5%) → no new alert.
  snapshotUniverse(db, "2026-09", rows([...august.slice(0, 19), "N06"]));
  const d3 = universeDeltaCheck(db, "2026-09", CFG);
  check("small drift stays quiet", !d3.alerted && d3.deltaPct <= CFG.universe.universeDeltaAlertPct);
}

// ---------- wikipedia parser (fixture HTML) ----------
{
  const rows = parseConstituentsHtml(WIKI_SP500_SAMPLE_HTML, "sp500");
  check("parses all data rows (skips decoy table)", rows.length === 3);
  check("symbol + sector extracted", rows[0].symbol === "MMM" && rows[0].sector === "Industrials");
  check("dot-class symbols preserved", rows.some((r) => r.symbol === "BRK.B"));
  check("CIK zero-padded to 10", rows.find((r) => r.symbol === "BRK.B")?.cik === "0001067983");
  let threw = false;
  try { parseConstituentsHtml("<html><body>nope</body></html>", "sp500"); } catch { threw = true; }
  check("missing constituents table throws", threw);
}

// ---------- EDGAR extraction (fixture companyfacts) ----------
{
  const facts = makeCompanyFacts({
    quarters: {
      Revenues: [100, 110, 120, 130],                                   // TTM 460
      CostOfRevenue: [60, 65, 70, 75],                                  // TTM 270 → GP 190
      OperatingIncomeLoss: [10, 12, 14, 16],                            // TTM 52
      NetIncomeLoss: [8, 9, 10, 11],                                    // TTM 38
      NetCashProvidedByUsedInOperatingActivities: [7, 8, 9, 10],        // TTM 34
    },
    instants: { Assets: 1000, LongTermDebtNoncurrent: 250, LongTermDebtCurrent: 50 },
  });
  const f = extractFundamentals(facts);
  check("GP/A from revenue − cogs chain", Math.abs(f.gpOverAssets! - 0.19) < 1e-12, String(f.gpOverAssets));
  check("TTM op income sums 4 quarters", f.ttmOpIncome === 52);
  check("accruals (NI−CFO)/Assets", Math.abs(f.accruals! - 0.004) < 1e-12, String(f.accruals));
  check("debt = LT noncurrent + current portions", Math.abs(f.debtOverAssets! - 0.3) < 1e-12, String(f.debtOverAssets));

  // Fallback tags + annual fallback + missing tags.
  const alt = makeCompanyFacts({
    quarters: { RevenueFromContractWithCustomerExcludingAssessedTax: [100, 100, 100, 100], CostOfGoodsAndServicesSold: [50, 50, 50, 50] },
    annual: { NetIncomeLoss: 40, NetCashProvidedByUsedInOperatingActivities: 30 },
    instants: { Assets: 1000, LongTermDebt: 100 },
  });
  const g = extractFundamentals(alt);
  check("fallback revenue/cogs tags work", Math.abs(g.gpOverAssets! - 0.2) < 1e-12);
  check("annual duration is the TTM fallback", Math.abs(g.accruals! - 0.01) < 1e-12, String(g.accruals));
  check("combined LongTermDebt tag fallback", Math.abs(g.debtOverAssets! - 0.1) < 1e-12);
  check("missing op income tag → null", g.ttmOpIncome === null);
  const empty = extractFundamentals({ facts: { "us-gaap": {} } });
  check("no tags at all → all null (veto upstream)", empty.gpOverAssets === null && empty.accruals === null && empty.debtOverAssets === null);
}

// ---------- shadow books: N=50 vs N=10 divergence ----------
{
  const db = openDb(":memory:");
  ensureMomTables(db);
  // 60 ranked symbols; July closes 100, August returns spread by rank (rank 1 = +6.0% … rank 60 = +0.1%).
  const ranked = Array.from({ length: 60 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);
  const closes = new Map<string, Map<string, number>>();
  ranked.forEach((s, i) => {
    const ret = (60 - i) * 0.001;
    closes.set(s, new Map([["2026-07", 100], ["2026-08", 100 * (1 + ret)]]));
  });
  runShadowMonth(db, "shadow50", "2026-07", ranked, 50, closes);
  runShadowMonth(db, "mirror", "2026-07", ranked, 10, closes);
  const s50 = runShadowMonth(db, "shadow50", "2026-08", ranked, 50, closes);
  const m10 = runShadowMonth(db, "mirror", "2026-08", ranked, 10, closes);
  check("shadow50 holds 50 names", s50.holdings.length === 50);
  check("mirror holds live N (10)", m10.holdings.length === 10);
  // Top-10 average return = (60+…+51)/10 × 0.1% = 5.55%; top-50 = (60+…+11)/50 × 0.1% = 3.55%.
  check("mirror month return ≈ 5.55%", Math.abs(m10.retPct! - 5.55) < 1e-9, String(m10.retPct));
  check("shadow50 month return ≈ 3.55%", Math.abs(s50.retPct! - 3.55) < 1e-9, String(s50.retPct));
  check("books DIVERGE on the same fixtures", Math.abs(m10.retPct! - s50.retPct!) > 1);
  check("NAV chains from 1", d9str(d9(m10.nav9)).startsWith("1.0555"), m10.nav9);
  // Idempotent re-run: same row, same NAV (REPLACE, not compound).
  const again = runShadowMonth(db, "shadow50", "2026-08", ranked, 50, closes);
  check("shadow re-run idempotent", again.nav9 === s50.nav9 && again.retPct === s50.retPct);
  const cmp = compareBooks(db, "2026-08");
  check("compare exposes both books", cmp.shadow50?.retPct === s50.retPct && cmp.mirror?.retPct === m10.retPct);
}

// ---------- execute(): sells → terminal → buys through the gateway, honesty ledger ----------
{
  const db = openDb(":memory:");
  ensureMomTables(db);
  seedBook(db, "5000", "2026-08-03");

  const submissions: string[] = [];
  const fakeBroker: BrokerPort = {
    async submit(req: BrokerOrderRequest): Promise<SubmitResult> {
      submissions.push(`${req.side}:${req.symbol}`);
      return { outcome: "accepted", order: { id: `ord-${submissions.length}`, status: "accepted", client_order_id: req.client_order_id } };
    },
    async queryByClientOrderId(coid: string) { return { id: "x", status: "filled", client_order_id: coid }; },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };

  const ranked = Array.from({ length: 30 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`);
  const holdings = new Map<string, Holding>([["S26", { qty9: d9("2"), price9: d9("50") }]]); // rank-out, $100
  const plan = planRebalance({ ranked, holdings, sleeveEquity9: d9("2000"), cfg: CFG });
  check("plan: 1 rank-out sell + 10 new buys (S26 out, 10 open slots, top10 all unheld)", plan.sells.length === 1 && plan.buys.length === 10, `${plan.sells.length}/${plan.buys.length}`);

  const opts = {
    asOfDate: "2026-08-03", configVersion: eff.version, washBlacklistDays: 31, cfg: CFG,
    nowEtMinutes: () => hhmmToMinutes("11:00"), sleep: async () => {}, pollTries: 3, pollDelayMs: 0,
  };

  // Window gate first.
  const early = { ...opts, nowEtMinutes: () => hhmmToMinutes("09:45") };
  const refused = await executeRebalance(db, fakeBroker, plan, early);
  check("outside 10:30–15:00 ET window → refused", !refused.executed && /window/.test(refused.reason ?? ""));
  check("refusal placed nothing", submissions.length === 0);

  const res = await executeRebalance(db, fakeBroker, plan, opts);
  check("executed inside the window", res.executed);
  check("all orders reached the broker", submissions.length === 11, String(submissions.length));
  check("every sell submitted before any buy", submissions.findIndex((s) => s.startsWith("buy:")) > submissions.filter((s) => s.startsWith("sell:")).length - 1
    && submissions.slice(0, plan.sells.length).every((s) => s.startsWith("sell:")));
  check("sell polled to terminal", res.placed.find((p) => p.side === "sell")?.terminal === "filled");

  const intents = db.prepare("SELECT client_order_id, side, status FROM order_intents WHERE sleeve='mom'").all() as any[];
  check("intents recorded under owner 'mom'", intents.length === 11 && intents.every((i) => i.status === "submitted"));

  // Honesty ledger: 5 bps/side + $0.01/sell, keyed to real coids, analytics only.
  const honesty = db.prepare("SELECT * FROM mom_honesty ORDER BY client_order_id").all() as any[];
  check("honesty row per placed order", honesty.length === 11);
  const sellRow = honesty.find((h) => h.side === "sell");
  check("sell slippage = $100 × 5bps = $0.05", sellRow?.slippage9 === "0.05", sellRow?.slippage9);
  check("sell fee $0.01", sellRow?.fee9 === "0.01");
  const buyRow = honesty.find((h) => h.side === "buy");
  check("buy slippage = $200 × 5bps = $0.10, no fee", buyRow?.slippage9 === "0.1" && buyRow?.fee9 === "0");
  const cashRows = db.prepare("SELECT COUNT(*) AS n FROM cash_events WHERE kind='fee'").get() as { n: number };
  check("honesty never touches the cash ledger", Number(cashRows.n) === 0);

  // Once-per-day guard.
  const rerun = await executeRebalance(db, fakeBroker, plan, opts);
  check("same-day re-run refused (state guard)", !rerun.executed && /already executed/.test(rerun.reason ?? ""));
  check("state guard recorded", getState(db, "mom:rebalance-done:2026-08-03") !== null);
  check("re-run placed nothing new", submissions.length === 11);
}

// ---------- month-end integration (fixture ports, zero network) ----------
{
  const db = openDb(":memory:");
  const up = (i: number) => Array(13).fill(0.03 - i * 0.001);   // decreasing momentum by index
  const symbols: FixtureSymbol[] = Array.from({ length: 8 }, (_, i) => ({
    symbol: `F${String(i + 1).padStart(2, "0")}`,
    sector: "Industrials",
    cik: `00000000${String(i + 10)}`,
    list: "sp500" as const,
    monthCloses: makeMonthCloses("2026-07", 100, up(i)),
    dailyCloses: Array.from({ length: 40 }, (_, d) => 100 * (1 + 0.002 * d)),
    facts: makeCompanyFacts({
      quarters: {
        Revenues: [100, 100, 100, 100], CostOfRevenue: [50, 50, 50, 50],
        OperatingIncomeLoss: [10, 10, 10, 10], NetIncomeLoss: [8, 8, 8, 8],
        NetCashProvidedByUsedInOperatingActivities: [9, 9, 9, 9],
      },
      instants: { Assets: 1000, LongTermDebtNoncurrent: 100 },
    }),
  }));
  symbols[3].facts = null;                    // F04: EDGAR knows nothing → missing-fundamentals veto
  symbols[5].fractionable = false;            // F06: not fractionable → out of the universe entirely
  symbols[6].monthCloses = makeMonthCloses("2026-07", 100, Array(5).fill(0.02)); // F07: history too short

  const ports = makeFixturePorts(symbols);
  const universe = await buildUniverse(ports, CFG);
  check("universe drops non-fractionable", !universe.some((u) => u.symbol === "F06"));
  check("universe drops short history", !universe.some((u) => u.symbol === "F07"));
  check("universe keeps the rest", universe.length === 6);

  const res = await runMonthEnd(db, ports, CFG, "2026-07", 2000);
  check("month-end snapshot written", (db.prepare("SELECT COUNT(*) AS n FROM mom_universe WHERE month='2026-07'").get() as any).n === 6);
  check("vetoed name recorded with reason", res.ranks.vetoed.some((v) => v.symbol === "F04" && v.reason === "missing-fundamentals"));
  check("final ranks exclude the vetoed name", res.ranks.final.every((r) => r.symbol !== "F04"));
  check("momentum order follows the fixture returns", res.ranks.final[0].symbol === "F01");
  const rankRows = db.prepare("SELECT COUNT(*) AS n FROM mom_ranks WHERE month='2026-07'").get() as any;
  check("mom_ranks persisted", Number(rankRows.n) === 6);
  check("shadow books written for the month",
    (db.prepare("SELECT COUNT(*) AS n FROM mom_shadow WHERE month='2026-07'").get() as any).n === 2);
  // Idempotent re-run of the whole ritual.
  const res2 = await runMonthEnd(db, ports, CFG, "2026-07", 2000);
  check("month-end re-run idempotent", res2.universeCount === res.universeCount
    && Number((db.prepare("SELECT COUNT(*) AS n FROM mom_ranks WHERE month='2026-07'").get() as any).n) === 6);
}

// ---------- facts-cache codec: gzip round-trip, legacy TEXT rows, corrupt rows ----------
{
  const facts = makeCompanyFacts({
    quarters: { Revenues: [100, 110, 120, 130] },
    instants: { Assets: 1000 },
  });
  const blob = encodeFacts(facts);
  check("codec: gzip round-trip is lossless", JSON.stringify(decodeFacts(blob)) === JSON.stringify(facts));
  check("codec: blob is actually gzip (magic bytes) and smaller than the JSON",
    blob[0] === 0x1f && blob[1] === 0x8b && blob.length < JSON.stringify(facts).length, `len ${blob.length}`);
  check("codec: legacy plain-TEXT row still decodes", JSON.stringify(decodeFacts(JSON.stringify(facts))) === JSON.stringify(facts));
  check("codec: corrupt row decodes to null (caller refetches)",
    decodeFacts("not json{") === null && decodeFacts(Buffer.from([1, 2, 3])) === null);
  // Through SQLite: a Buffer stored in the TEXT-declared column comes back as a BLOB (Uint8Array).
  const db = openDb(":memory:");
  ensureMomTables(db);
  db.prepare("INSERT INTO mom_facts_cache(cik, fetched_ts, json) VALUES(?,?,?)").run("0000000001", new Date().toISOString(), blob);
  const row = db.prepare("SELECT json FROM mom_facts_cache WHERE cik=?").get("0000000001") as { json: unknown };
  check("codec: survives a SQLite BLOB round-trip", JSON.stringify(decodeFacts(row.json)) === JSON.stringify(facts));
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall momentum checks passed");
process.exit(failures ? 1 : 0);
