// Offline tests — v2 tax + cash ledgers: FIFO lots, disposals, wash-sale engine, settled cash.
// Uses :memory: SQLite; no network, no env.
import { openDb, getState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { ingestFill, ledgerPosition, ledgerPositions, termFor, addDays, applyForwardSplit, OversellError } from "./v2/lots.js";
import { scanWash, lossExitWithin } from "./v2/wash.js";
import { seedBook, settledCash, totalCash, gateBuy, recordCash, nextTradingDay } from "./v2/settled-cash.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

console.log("v2 ledger:");

// ---------- FIFO basics ----------
{
  const db = openDb(":memory:");
  // Buy 10 @ 100, buy 5 @ 110, sell 12 @ 120 → consumes lot1 fully (10) + 2 of lot2.
  ingestFill(db, { id: "f1", symbol: "AAPL", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-01-05T15:00:00Z" });
  ingestFill(db, { id: "f2", symbol: "AAPL", side: "buy", qty9: d9("5"), price9: d9("110"), ts: "2026-02-05T15:00:00Z" });
  const { disposals } = ingestFill(db, { id: "f3", symbol: "AAPL", side: "sell", qty9: d9("12"), price9: d9("120"), ts: "2026-06-05T15:00:00Z" });
  check("two disposal rows (sell × lot)", disposals.length === 2);
  check("FIFO consumed oldest first", disposals[0].qty9 === "10" && disposals[1].qty9 === "2");
  check("lot1 basis exact", disposals[0].basis9 === "1000");
  check("lot2 partial basis exact", disposals[1].basis9 === "220");
  check("proceeds sum exact", d9(disposals[0].proceeds9) + d9(disposals[1].proceeds9) === d9("1440"));
  check("realized gains", disposals[0].realized9 === "200" && disposals[1].realized9 === "20");
  check("no provisional wash on gains", disposals[0].wash_provisional_until === null);
  check("remaining position", d9str(ledgerPosition(db, "AAPL")) === "3");
  check("replay idempotent", ingestFill(db, { id: "f3", symbol: "AAPL", side: "sell", qty9: d9("12"), price9: d9("120"), ts: "2026-06-05T15:00:00Z" }).inserted === false);

  // Oversell → OversellError (ledger/broker mismatch signal)
  let overselled = false;
  try { ingestFill(db, { id: "f4", symbol: "AAPL", side: "sell", qty9: d9("99"), price9: d9("120"), ts: "2026-06-06T15:00:00Z" }); }
  catch (e) { overselled = e instanceof OversellError; }
  check("oversell throws OversellError", overselled);
  check("oversell rolled back (no partial rows)", ledgerPosition(db, "AAPL") === d9("3"));
}

// ---------- fractional + exact-basis-summation ----------
{
  const db = openDb(":memory:");
  // Fractional buy at an awkward price; sell in 3 parts; disposal bases must sum EXACTLY to lot basis.
  ingestFill(db, { id: "b1", symbol: "GOOG", side: "buy", qty9: d9("0.123456789"), price9: d9("173.333333333"), ts: "2026-01-05T15:00:00Z" });
  const basisTotal = (openLotBasis(db, "GOOG"));
  const d1 = ingestFill(db, { id: "s1", symbol: "GOOG", side: "sell", qty9: d9("0.04"), price9: d9("180"), ts: "2026-01-20T15:00:00Z" }).disposals;
  const d2 = ingestFill(db, { id: "s2", symbol: "GOOG", side: "sell", qty9: d9("0.04"), price9: d9("181"), ts: "2026-01-21T15:00:00Z" }).disposals;
  const d3 = ingestFill(db, { id: "s3", symbol: "GOOG", side: "sell", qty9: d9("0.043456789"), price9: d9("182"), ts: "2026-01-22T15:00:00Z" }).disposals;
  const basisSum = d9(d1[0].basis9) + d9(d2[0].basis9) + d9(d3[0].basis9);
  check("fractional disposal bases sum EXACTLY to lot basis", basisSum === basisTotal, `${d9str(basisSum)} vs ${d9str(basisTotal)}`);
  check("position exactly zero", ledgerPosition(db, "GOOG") === 0n);
  check("positions map drops zeros", !ledgerPositions(db).has("GOOG"));

  function openLotBasis(db2: any, sym: string): bigint {
    const r = db2.prepare("SELECT basis_total9 FROM lots WHERE symbol=?").get(sym) as { basis_total9: string };
    return d9(r.basis_total9);
  }
}

// ---------- term + tack helpers ----------
check("short term at exactly 1yr", termFor("2025-06-05T15:00:00Z", "2026-06-05T15:00:00Z") === "short");
check("long term at 1yr+1s", termFor("2025-06-05T15:00:00Z", "2026-06-05T15:00:01Z") === "long");
check("addDays", addDays("2026-12-20", 31) === "2027-01-20");

// ---------- wash sale: forward match (sell at loss, rebuy within 30d) ----------
{
  const db = openDb(":memory:");
  ingestFill(db, { id: "w1", symbol: "TSLA", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-01-05T15:00:00Z" });
  const loss = ingestFill(db, { id: "w2", symbol: "TSLA", side: "sell", qty9: d9("10"), price9: d9("90"), ts: "2026-03-02T15:00:00Z" }).disposals;
  check("loss realized −100", loss[0].realized9 === "-100");
  check("provisional until close+31d", loss[0].wash_provisional_until === addDays("2026-03-02", 31));
  check("blacklist active", lossExitWithin(db, "TSLA", 31, "2026-03-20"));
  check("blacklist expires", !lossExitWithin(db, "TSLA", 31, "2026-04-15"));

  // No replacement yet → scan finds nothing.
  check("no premature wash match", scanWash(db).length === 0);
  // Rebuy 6 within 30 days → wash on 6 of the 10 shares (disallowed = 60 of the 100 loss).
  ingestFill(db, { id: "w3", symbol: "TSLA", side: "buy", qty9: d9("6"), price9: d9("92"), ts: "2026-03-20T15:00:00Z" });
  const matches = scanWash(db);
  check("one wash match", matches.length === 1);
  check("disallowed 60 (6/10 of loss)", matches[0]?.disallowed9 === "60", JSON.stringify(matches));
  const disp = db.prepare("SELECT wash_disallowed9, realized9 FROM disposals WHERE sell_fill_id='w2'").get() as any;
  check("disposal carries disallowed", disp.wash_disallowed9 === "60");
  check("economic realized unchanged", disp.realized9 === "-100");
  const lot = db.prepare("SELECT wash_adj_basis9, basis_remaining9, holding_period_start_ts, open_ts FROM lots WHERE open_fill_id='w3'").get() as any;
  check("replacement basis adjusted +60 (552 → 612)", lot.wash_adj_basis9 === "60" && lot.basis_remaining9 === "612");
  check("holding period tacked earlier than open", lot.holding_period_start_ts < lot.open_ts);
  check("re-scan idempotent", scanWash(db).length === 0);

  // Selling the replacement later uses the ADJUSTED basis (the deferred loss travels).
  const resale = ingestFill(db, { id: "w4", symbol: "TSLA", side: "sell", qty9: d9("6"), price9: d9("92"), ts: "2026-08-10T15:00:00Z" }).disposals;
  check("resale basis includes deferred loss", resale[0].basis9 === "612");
  check("resale realized carries deferral", resale[0].realized9 === "-60");
}

// ---------- wash sale: back match (replacement bought BEFORE the loss sale) ----------
{
  const db = openDb(":memory:");
  ingestFill(db, { id: "x1", symbol: "NVDA", side: "buy", qty9: d9("10"), price9: d9("100"), ts: "2026-01-05T15:00:00Z" });
  ingestFill(db, { id: "x2", symbol: "NVDA", side: "buy", qty9: d9("4"), price9: d9("95"), ts: "2026-02-20T15:00:00Z" }); // in-window earlier buy
  // FIFO sell of 10 @ 90 consumes the OLD lot at a 100-basis → loss 100; the 02-20 lot (4 sh) is a replacement.
  ingestFill(db, { id: "x3", symbol: "NVDA", side: "sell", qty9: d9("10"), price9: d9("90"), ts: "2026-03-10T15:00:00Z" });
  const matches = scanWash(db);
  check("back-match found", matches.length === 1 && matches[0].qty9 === "4");
  check("back-match disallowed 40", matches[0]?.disallowed9 === "40");
}

// ---------- forward split self-adjust ----------
{
  const db = openDb(":memory:");
  ingestFill(db, { id: "sp1", symbol: "SMCI", side: "buy", qty9: d9("3"), price9: d9("900"), ts: "2026-01-05T15:00:00Z" });
  applyForwardSplit(db, "SMCI", 10n, 1n, "2026-02-01T00:00:00Z");
  check("split qty ×10", d9str(ledgerPosition(db, "SMCI")) === "30");
  const lot = db.prepare("SELECT basis_total9, basis_remaining9 FROM lots WHERE symbol='SMCI'").get() as any;
  check("split basis unchanged in total", lot.basis_total9 === "2700" && lot.basis_remaining9 === "2700");
  check("broker-stale flag set", getState(db, "split_stale:SMCI") !== null);
}

// ---------- settled cash ----------
{
  const db = openDb(":memory:");
  check("seed inserts", seedBook(db, "5000", "2026-08-17"));
  check("seed idempotent", !seedBook(db, "5000", "2026-08-17"));
  check("settled = 5000", d9str(settledCash(db, "2026-08-17")) === "5000");

  // Buy debits same day; sell credits T+1.
  recordCash(db, { ts: "2026-08-17T14:00:00Z", kind: "buy", symbol: "AAPL", amount9: -d9("2000"), settlesOn: "2026-08-17", ref: "cb1" });
  recordCash(db, { ts: "2026-08-18T14:00:00Z", kind: "sell", symbol: "AAPL", amount9: d9("2100"), settlesOn: nextTradingDay("2026-08-18"), ref: "cs1" });
  check("buy debits immediately", d9str(settledCash(db, "2026-08-17")) === "3000");
  check("sale proceeds NOT settled same day", d9str(settledCash(db, "2026-08-18")) === "3000");
  check("sale proceeds settle T+1", d9str(settledCash(db, "2026-08-19")) === "5100");
  check("total cash includes unsettled", d9str(totalCash(db)) === "5100");
  check("cash replay idempotent", !recordCash(db, { ts: "2026-08-17T14:00:00Z", kind: "buy", symbol: "AAPL", amount9: -d9("2000"), settlesOn: "2026-08-17", ref: "cb1" }));

  // GFV gate: buying more than settled increments the counter and refuses.
  const gate = gateBuy(db, d9("3500"), "2026-08-18");
  check("gateBuy refuses unsettled spend", !gate.ok && d9str(gate.settled9) === "3000");
  check("GFV counter incremented", getState(db, "gfv_attempts") === "1");
  check("gateBuy allows within settled", gateBuy(db, d9("2999"), "2026-08-18").ok);

  // nextTradingDay: Friday → Monday; over a holiday (2026-09-07 Labor Day) Fri 09-04 → Tue 09-08.
  check("T+1 weekend roll", nextTradingDay("2026-08-21") === "2026-08-24");
  check("T+1 holiday roll", nextTradingDay("2026-09-04") === "2026-09-08");
  check("T+1 with explicit sessions", nextTradingDay("2026-08-18", ["2026-08-18", "2026-08-19"]) === "2026-08-19");
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 ledger: all green");
