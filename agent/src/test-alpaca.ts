// SUCCESS / FAIL / NULL tests for Alpaca idempotency. NO live or paper orders, NO money-rail calls —
// global.fetch is stubbed so the placement path runs end-to-end against a FAKE broker response.
// Run: npm run test:alpaca

// alpaca.ts enforces the paper host + reads API keys at module load. Set safe dummies and force the
// default paper host BEFORE importing it (dynamic import below runs after these statements). fetch is
// mocked in every order test, so these dummies never leave the process — no real account is touched.
process.env.ALPACA_API_KEY = "test-key-not-real";
process.env.ALPACA_API_SECRET = "test-secret-not-real";
delete process.env.ALPACA_BASE_URL; // default → https://paper-api.alpaca.markets (module-load guard)

const { billOrderId, DuplicateClientOrderIdError, isDuplicateClientOrderIdResponse, placeTrailingStop, placePaperOrder } =
  await import("./alpaca.js");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// --- billOrderId: documented shape  bill-<sym>-<YYYYMMDD-HHmm digits>-<8hex>[-suffix] ------------
check("SHAPE: default id matches bill-<SYM>-<12d>-<8hex>", /^bill-[A-Z0-9]{1,8}-\d{12}-[0-9a-f]{8}$/.test(billOrderId("AMD")));
check("SHAPE: suffix appended as -<suffix>", /^bill-AMD-\d{12}-[0-9a-f]{8}-stop$/.test(billOrderId("AMD", "stop")));
check("SHAPE: symbol uppercased + non-alnum stripped (brk.b → BRKB)", billOrderId("brk.b").startsWith("bill-BRKB-"));
check("SHAPE: symbol truncated to 8 chars (ABCDEFGHIJ → ABCDEFGH)", billOrderId("ABCDEFGHIJ").startsWith("bill-ABCDEFGH-"));
check("SHAPE: stays within Alpaca's 48-char client_order_id cap", billOrderId("ABCDEFGHIJKLMNOP", "stop").length <= 48);

// --- billOrderId: uniqueness across calls (8 hex of randomness; same-minute ts is identical) ------
const ids = new Set<string>();
for (let i = 0; i < 200; i++) ids.add(billOrderId("AMD", "buy"));
check("UNIQUE: 200 calls → 200 distinct ids", ids.size === 200);

// --- DuplicateClientOrderIdError sentinel ---------------------------------------------------------
const sentinel = new DuplicateClientOrderIdError("bill-AMD-202606151423-deadbeef", "...duplicate client_order_id...");
check("ERROR: is an Error subclass", sentinel instanceof Error);
check("ERROR: name is DuplicateClientOrderIdError", sentinel.name === "DuplicateClientOrderIdError");
check("ERROR: carries the client_order_id", sentinel.clientOrderId === "bill-AMD-202606151423-deadbeef");

// --- isDuplicateClientOrderIdResponse: the pure classifier ----------------------------------------
check("CLASSIFY: 422 + 'duplicate client_order_id' → true", isDuplicateClientOrderIdResponse(422, "422: duplicate client_order_id: bill-AMD-x") === true);
check("CLASSIFY: case-insensitive on the body", isDuplicateClientOrderIdResponse(422, "DUPLICATE CLIENT_ORDER_ID") === true);
check("CLASSIFY: 422 + other reason → false (specific, not all-422)", isDuplicateClientOrderIdResponse(422, "insufficient buying power") === false);
check("CLASSIFY: non-422 status → false even with dup text", isDuplicateClientOrderIdResponse(200, "duplicate client_order_id") === false);
check("CLASSIFY: 403 → false", isDuplicateClientOrderIdResponse(403, "forbidden") === false);

// --- swallow path: placeTrailingStop recognizes + swallows the dup (mocked fetch, no real order) ---
const origFetch = globalThis.fetch;
const fakeResponse = (status: number, bodyText: string, jsonVal: unknown = {}) => ({
  ok: status >= 200 && status < 300, status, text: async () => bodyText, json: async () => jsonVal,
});
const stubFetch = (status: number, bodyText: string, jsonVal?: unknown) => {
  globalThis.fetch = (async () => fakeResponse(status, bodyText, jsonVal)) as unknown as typeof fetch;
};
try {
  // A duplicate (422) is swallowed-as-success → null, no throw.
  stubFetch(422, "duplicate client_order_id: bill-AMD-202606151423-deadbeef");
  let dupResult: unknown = "unset";
  try { dupResult = await placeTrailingStop("AMD", 10, 20); } catch { dupResult = "THREW"; }
  check("SWALLOW: duplicate 422 swallowed as success (returns null)", dupResult === null);

  // A NON-duplicate 422 must still surface as an error (proves the guard is specific, not a 422 sink).
  stubFetch(422, "insufficient buying power");
  let threw = false;
  try { await placeTrailingStop("AMD", 10, 20); } catch { threw = true; }
  check("SWALLOW: non-duplicate 422 still throws (not swallowed)", threw === true);

  // A successful placement returns the broker order object (proves null is the dup signal, not the norm).
  stubFetch(200, "", { id: "fake-order-1", status: "accepted" });
  const okResult = await placeTrailingStop("AMD", 10, 20) as { id?: string } | null;
  check("SWALLOW: successful placement returns the order (not null)", !!okResult && okResult.id === "fake-order-1");

  // --- REPLAY: idempotent dup where the original order can't be re-fetched (entry has no id) ---------
  // POST → 422 dup (prior placement already landed); GET status=all → [] (order not in the recent list),
  // so the fallback entry carries no id. The stop must be SKIPPED, not polled against /v2/orders/undefined.
  // Before the guard, waitForOrderTerminal(undefined) would spin until the 45s timeout (slow + wrong
  // reason); after the guard it returns instantly with the replay reason. The third branch below is a
  // tripwire: if the (fixed) code ever polls, it gets a non-terminal order and the reason assertion fails.
  globalThis.fetch = (async (url: unknown, init: { method?: string } = {}) => {
    const u = String(url); const method = init.method ?? "GET";
    if (method === "POST" && u.includes("/v2/orders")) return fakeResponse(422, "duplicate client_order_id: bill-AMD-x");
    if (method === "GET" && u.includes("status=all")) return fakeResponse(200, "[]", []);
    return fakeResponse(200, "", { id: "should-not-be-polled", status: "new" });
  }) as unknown as typeof fetch;
  const replay = await placePaperOrder({ symbol: "AMD", side: "buy", qty: 10, type: "market", est_price: 100, trail_percent: 20 });
  check("REPLAY: idempotent dup is flagged", replay.idempotent === true);
  check("REPLAY: entry carries no id (order not re-fetched)", (replay.entry as { id?: string })?.id == null);
  check("REPLAY: stop skipped (not polled) when original order id is unavailable",
    replay.stop === undefined && /idempotent replay/.test(replay.stopSkippedReason ?? ""));
} finally {
  globalThis.fetch = origFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
