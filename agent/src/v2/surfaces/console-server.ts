// Bull v2 — operator console server (design §9). Serves the console page + read APIs over the v2
// ledger DB, and the small set of OPERATOR mutations: approvals resolution, sleeve pause/resume,
// the book kill-switch, mode, and judgment-mode restore. Carries the v1 control-server's hardened
// auth forward: binds 127.0.0.1 (Caddy/tailnet owns outer access on the VPS), state-changing
// endpoints need the x-control-token header (constant-time compared) + a same-origin Origin, the
// token is NEVER embedded in the served page (URL-fragment handoff), and read-only GETs stay open.
//   npm run v2:console   →   http://localhost:4326/#token=<BULL_CONTROL_TOKEN>
import "./../../load-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { openDb, getState, setState, clearState, DEFAULT_DB_PATH } from "./../db.js";
import { d9, d9num } from "./../decimal.js";
import { loadConfig } from "./../config.js";
import { equityCurve, realizedMaxDrawdownPct } from "./../book/equity.js";
import { benchSeries, gateProgress } from "./../book/benchmarks.js";
import { ensureWatchlistTables } from "./../book/watchlist.js";
import { SLEEVES } from "./../types.js";
import { installSafetyNet, timingSafeTokenMatch } from "./../../http-utils.js";
import { getMode, setMode, MODES, type Mode } from "./../../mode.js";
import type { DatabaseSync } from "node:sqlite";

const SERVICE = "bull-v2-console";
installSafetyNet(SERVICE);

const PORT = Number(process.env.BULL_CONSOLE_PORT || 4326);
const PAGE = fileURLToPath(new URL("./console-page.html", import.meta.url));
const ENV_TOKEN = (process.env.BULL_CONTROL_TOKEN || "").trim();
const CONTROL_TOKEN = ENV_TOKEN || randomBytes(32).toString("hex");
// Public-origin mode (VPS): Caddy fronts this server with basic_auth and INJECTS x-control-token
// via header_up on every authenticated request — the operator signs in once and the token never
// reaches the browser. The origin allowlist must then include the public site, and stays strict:
// a cross-site POST (CSRF riding auto-attached basic_auth creds) carries the attacker's Origin and
// is refused here regardless of the injected token.
const PUBLIC_ORIGIN = (process.env.BULL_CONSOLE_ORIGIN || "").trim().replace(/\/+$/, "");
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...(PUBLIC_ORIGIN ? [PUBLIC_ORIGIN] : []),
]);
const BODY_CAP = 64 * 1024;

const db = openDb(process.env.BULL_DB_PATH || DEFAULT_DB_PATH);
ensureWatchlistTables(db);

const sendJson = (res: ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};
const headerStr = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

const originOk = (req: IncomingMessage): boolean => {
  const o = headerStr(req.headers.origin);
  return o == null || ALLOWED_ORIGINS.has(o);
};
const tokenOk = (req: IncomingMessage): boolean =>
  timingSafeTokenMatch(headerStr(req.headers["x-control-token"]) ?? "", CONTROL_TOKEN);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > BODY_CAP) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

/** Defensive read of a sleeve-owned table — absent table (sleeve not built/launched) = []. */
function tryAll(dbh: DatabaseSync, sql: string, ...params: unknown[]): unknown[] {
  try { return dbh.prepare(sql).all(...(params as [])) as unknown[]; } catch { return []; }
}

function seriesOut(name: string): { date: string; v: number }[] {
  return benchSeries(db, name).map((r) => ({ date: r.date, v: d9num(r.value9) }));
}

function stateStrip() {
  const halts: Record<string, string | null> = { book: getState(db, "halt:book") };
  for (const s of SLEEVES) halts[s] = getState(db, `halt:${s}`);
  const dialRaw = getState(db, "dial:lei");
  return {
    mode: getMode(),
    dial: dialRaw ? JSON.parse(dialRaw) : null,
    brakeTier: Number(getState(db, "brake:tier") ?? "0"),
    brakePeak: getState(db, "brake:peak9") ? d9num(BigInt(getState(db, "brake:peak9")!)) : null,
    halts,
    judgmentMode: getState(db, "judg:mode") ?? "protocol",
    gfvAttempts: Number(getState(db, "gfv_attempts") ?? "0"),
    pendingApprovals: (db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status='pending'").get() as { n: number }).n,
  };
}

function apiSummary() {
  const cfg = loadConfig();
  const asOf = new Date().toISOString().slice(0, 10);
  return {
    configVersion: cfg.version,
    strip: stateStrip(),
    equity: equityCurve(db).map((m) => ({ date: m.date, v: d9num(m.equity9), dial: m.dial, brakeTier: m.brakeTier })),
    spy: seriesOut("SPY"),
    sleeves: Object.fromEntries(SLEEVES.map((s) => [s, seriesOut(`sleeve:${s}`)])),
    rivals: { mom: seriesOut("QMOM"), ins: seriesOut("IWM"), anc: seriesOut("NANC") },
    gate: gateProgress(db, { asOfDate: asOf, ddCeilingPct: 15 }),
    maxDd: realizedMaxDrawdownPct(db),
  };
}

function apiTrades(limit: number) {
  const intents = db.prepare(
    `SELECT client_order_id, sleeve, symbol, intent, date, side, qty9, notional9, order_type, status,
            broker_order_id, skip_reason, submitted_ts, config_version
     FROM order_intents ORDER BY date DESC, seq DESC LIMIT ?`,
  ).all(limit) as any[];
  const out = intents.map((i) => {
    const fill = i.broker_order_id
      ? (db.prepare("SELECT price9, qty9, ts FROM fills WHERE order_id=? ORDER BY ts DESC LIMIT 1").get(i.broker_order_id) as any)
      : null;
    const verdict = tryAll(db,
      "SELECT class AS cls, action, ts FROM jdg_verdicts WHERE symbol=? ORDER BY ts DESC LIMIT 1", i.symbol)[0] as any;
    const realized = (db.prepare("SELECT COALESCE(SUM(CAST(realized9 AS REAL)),0) AS r FROM disposals WHERE symbol=?").get(i.symbol) as any).r;
    return {
      ...i,
      fillPrice: fill ? d9num(d9(fill.price9)) : null,
      fillTs: fill?.ts ?? null,
      lastVerdict: verdict ?? null,
      symbolRealized: realized,
    };
  });
  return { trades: out };
}

function apiSignals() {
  return {
    watchlist: tryAll(db, "SELECT * FROM wl_exits WHERE status IN ('active','reentry_flagged') ORDER BY ts DESC"),
    approvals: tryAll(db, "SELECT * FROM approvals WHERE status='pending' ORDER BY ts ASC"),
    resolvedApprovals: tryAll(db, "SELECT * FROM approvals WHERE status != 'pending' ORDER BY resolved_ts DESC LIMIT 20"),
    momentum: tryAll(db,
      `SELECT symbol, score, fip, mom_rank, final_rank, veto FROM mom_ranks
       WHERE month = (SELECT MAX(month) FROM mom_ranks) ORDER BY COALESCE(final_rank, 999), mom_rank LIMIT 60`),
    insiderClusters: tryAll(db, "SELECT * FROM ins_clusters ORDER BY detected_ts DESC LIMIT 20"),
    anchorClone: tryAll(db, "SELECT period_tag, targets_json, total_weight9, config_version, ts FROM anc_builds ORDER BY build_id DESC LIMIT 1"),
    wildcardPicks: tryAll(db, "SELECT * FROM wld_picks ORDER BY week DESC LIMIT 4"),
    verdicts: tryAll(db, "SELECT * FROM jdg_verdicts ORDER BY ts DESC LIMIT 20"),
  };
}

const HALT_TARGETS = new Set([...SLEEVES, "book"]);

async function handleMutation(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!originOk(req)) return sendJson(res, 403, { error: "cross-origin refused" });
  if (!tokenOk(req)) return sendJson(res, 401, { error: "bad token" });
  let body: any = {};
  try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }

  if (path === "/api/v2/approvals") {
    const id = Number(body.id);
    const action = String(body.action);
    if (!Number.isInteger(id) || !["approve", "reject"].includes(action)) return sendJson(res, 400, { error: "need id + action approve|reject" });
    const r = db.prepare("UPDATE approvals SET status=?, resolved_ts=?, resolved_by='cj' WHERE id=? AND status='pending'")
      .run(action === "approve" ? "approved" : "rejected", new Date().toISOString(), id);
    return sendJson(res, 200, { ok: Number(r.changes) === 1 });
  }
  if (path === "/api/v2/halt") {
    const target = String(body.target);
    const action = String(body.action);
    if (!HALT_TARGETS.has(target as never) || !["set", "clear"].includes(action)) return sendJson(res, 400, { error: "need target + action set|clear" });
    if (action === "set") setState(db, `halt:${target}`, String(body.reason || `operator pause @ ${new Date().toISOString()}`));
    else clearState(db, `halt:${target}`);
    return sendJson(res, 200, { ok: true, halts: stateStrip().halts });
  }
  if (path === "/api/v2/mode") {
    const mode = String(body.mode) as Mode;
    if (!MODES.includes(mode)) return sendJson(res, 400, { error: `mode must be one of ${MODES.join("|")}` });
    setMode(mode);
    return sendJson(res, 200, { ok: true, mode: getMode() });
  }
  if (path === "/api/v2/judgment-mode") {
    // Un-reverting the thesis-check kill-switch is deliberately a manual operator action.
    if (String(body.action) !== "restore") return sendJson(res, 400, { error: "action must be 'restore'" });
    clearState(db, "judg:mode");
    return sendJson(res, 200, { ok: true, judgmentMode: "protocol" });
  }
  return sendJson(res, 404, { error: "unknown endpoint" });
}

export const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET") {
      if (path === "/" ) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(PAGE, "utf8"));
      }
      if (path === "/health") return sendJson(res, 200, { ok: true, service: SERVICE });
      if (path === "/api/v2/summary") return sendJson(res, 200, apiSummary());
      if (path === "/api/v2/trades") {
        const limit = Math.min(500, Math.max(1, Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit")) || 100));
        return sendJson(res, 200, apiTrades(limit));
      }
      if (path === "/api/v2/signals") return sendJson(res, 200, apiSignals());
      return sendJson(res, 404, { error: "not found" });
    }
    if (req.method === "POST") return await handleMutation(req, res, path);
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (e) {
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

// Direct-run only (tests import the handlers without listening).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[${SERVICE}] http://localhost:${PORT}  (db: ${process.env.BULL_DB_PATH || DEFAULT_DB_PATH})`);
    console.log(`  → open http://localhost:${PORT}/#token=<BULL_CONTROL_TOKEN>`);
    if (!ENV_TOKEN) console.log("  (BULL_CONTROL_TOKEN unset — ephemeral token this boot; mutations unavailable from the page)");
  });
}
