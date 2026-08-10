// Offline tests — v2 console server endpoint guards. Boots the real server on an ephemeral port
// with an :memory: DB + a known token, then exercises the auth/API contract over real HTTP.
// (The full UI was additionally live-verified in a browser at build time; this suite keeps the
// GUARDS from regressing.)
process.env.BULL_DB_PATH = ":memory:";
process.env.BULL_CONTROL_TOKEN = "test-token-123";

const { server } = await import("./v2/surfaces/console-server.js");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const TOK = { "x-control-token": "test-token-123" };

console.log("v2 console guards:");

// Reads open, unknowns 404.
check("health open", (await fetch(base + "/health")).status === 200);
const sum = await (await fetch(base + "/api/v2/summary")).json();
check("summary shape", sum.strip && Array.isArray(sum.equity) && sum.gate && typeof sum.configVersion === "string");
check("empty book: no marks", sum.equity.length === 0 && sum.gate.green === false);
check("trades endpoint", Array.isArray((await (await fetch(base + "/api/v2/trades?limit=5")).json()).trades));
const sig = await (await fetch(base + "/api/v2/signals")).json();
check("signals: absent sleeve tables = empty arrays", Array.isArray(sig.momentum) && sig.momentum.length === 0);
check("page served without token", (await (await fetch(base + "/")).text()).includes("Bill · v2 console"));
check("page never embeds the token", !(await (await fetch(base + "/")).text()).includes("test-token-123"));
check("unknown GET 404", (await fetch(base + "/api/v2/nope")).status === 404);

// Mutation guards.
check("no token → 401", (await post("/api/v2/halt", { target: "mom", action: "set" })).status === 401);
check("wrong token → 401", (await post("/api/v2/halt", { target: "mom", action: "set" }, { "x-control-token": "nope" })).status === 401);
check("cross-origin refused even with token", (await post("/api/v2/halt", { target: "mom", action: "set" }, { ...TOK, origin: "https://evil.example" })).status === 403);
check("bad target 400", (await post("/api/v2/halt", { target: "everything", action: "set" }, TOK)).status === 400);

// Halt set/clear round trip.
check("halt set ok", (await (await post("/api/v2/halt", { target: "mom", action: "set", reason: "test" }, TOK)).json()).halts.mom === "test");
const s2 = await (await fetch(base + "/api/v2/summary")).json();
check("halt visible in strip", s2.strip.halts.mom === "test");
check("halt clear ok", (await (await post("/api/v2/halt", { target: "mom", action: "clear" }, TOK)).json()).halts.mom === null);

// Kill-switch is just halt:book.
await post("/api/v2/halt", { target: "book", action: "set", reason: "KILL" }, TOK);
check("kill-switch sets halt:book", (await (await fetch(base + "/api/v2/summary")).json()).strip.halts.book === "KILL");
await post("/api/v2/halt", { target: "book", action: "clear" }, TOK);

// Mode validation.
check("bad mode 400", (await post("/api/v2/mode", { mode: "yolo" }, TOK)).status === 400);

// Approvals: pending-only resolution, idempotent.
check("approve missing id → ok:false", (await (await post("/api/v2/approvals", { id: 999, action: "approve" }, TOK)).json()).ok === false);
check("judgment restore requires action", (await post("/api/v2/judgment-mode", { action: "break" }, TOK)).status === 400);
check("judgment restore ok", (await (await post("/api/v2/judgment-mode", { action: "restore" }, TOK)).json()).judgmentMode === "protocol");

server.close();
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 console: all green");
