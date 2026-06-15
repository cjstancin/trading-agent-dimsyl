// Local control panel for "Bill the Bull" — flips the bot's MODE (off | gated | auto) that the rituals
// read from the MODE file, and runs a ritual on demand. LOCAL ONLY: binds 127.0.0.1 so a public page can
// never drive a live trading bot. The public dashboard only *displays* the mode (read-only).
//   npm run control   →   http://localhost:4317
import "./load-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMode, setMode, autoExecAllowed, MODES, type Mode } from "./mode.js";
import { getProfile, setProfile, PROFILES, type Profile } from "./profile.js";
import { installSafetyNet } from "./http-utils.js";

const SERVICE = "bill-control";
const START_MS = Date.now();
installSafetyNet(SERVICE);

const PORT = Number(process.env.BILL_CONTROL_PORT || 4317);
const PAGE = fileURLToPath(new URL("./control-page.html", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const RITUALS = new Set(["premarket", "execute", "refresh"]);
// Cap any single ritual run — a hung Claude SDK call must not pin the HTTP socket or accumulate zombie
// children if CJ clicks "Run" multiple times. 5 min covers a full premarket cycle with margin.
const RITUAL_TIMEOUT_MS = Number(process.env.BILL_RITUAL_TIMEOUT_MS || 5 * 60_000);

const sendJson = (res: ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(PAGE, "utf8"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, { mode: getMode(), autoExec: autoExecAllowed(), profile: getProfile() });
    }
    // Fleet-standard health probe (same contract as SAMS /health, Atlas /health). Includes mode +
    // profile so a monitor can see Bill's current trading posture at a glance.
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: SERVICE, uptimeSec: Math.round((Date.now() - START_MS) / 1000), mode: getMode(), profile: getProfile() });
    }
    if (req.method === "POST" && url.pathname === "/api/profile") {
      let body = "";
      for await (const c of req) body += c;
      const p = String((JSON.parse(body || "{}").profile ?? "")).toLowerCase();
      if (!(PROFILES as string[]).includes(p)) return sendJson(res, 400, { ok: false, error: `bad profile "${p}"` });
      setProfile(p as Profile);
      return sendJson(res, 200, { ok: true, profile: getProfile() });
    }
    if (req.method === "POST" && url.pathname === "/api/mode") {
      let body = "";
      for await (const c of req) body += c;
      const m = String((JSON.parse(body || "{}").mode ?? "")).toLowerCase();
      if (!(MODES as string[]).includes(m)) return sendJson(res, 400, { ok: false, error: `bad mode "${m}"` });
      setMode(m as Mode);
      return sendJson(res, 200, { ok: true, mode: getMode(), autoExec: autoExecAllowed() });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const ritual = url.searchParams.get("ritual") || "premarket";
      const dry = url.searchParams.get("dry") === "1";
      if (!RITUALS.has(ritual)) return sendJson(res, 400, { ok: false, error: "unknown ritual" });
      const env = dry ? { ...process.env, BILL_DRY_RUN: "1" } : process.env;
      const child = spawn("npm", ["run", ritual], { cwd: AGENT_DIR, shell: true, env });
      let out = "";
      let settled = false;
      const finish = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        sendJson(res, 200, payload);
      };
      // Hard cap so a stuck ritual can't hold the response open or leave a zombie. SIGTERM, then SIGKILL.
      const killTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5_000).unref();
        finish({ ok: false, ritual, code: null, timedOut: true, tail: out.slice(-1600) });
      }, RITUAL_TIMEOUT_MS);
      killTimer.unref();
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => { clearTimeout(killTimer); finish({ ok: false, ritual, code: null, error: String(e?.message || e), tail: out.slice(-1600) }); });
      child.on("close", (code) => { clearTimeout(killTimer); finish({ ok: code === 0, ritual, code, tail: out.slice(-1600) }); });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  🐂  Bill the Bull — control panel`);
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  mode: ${getMode()}  ·  auto-exec armed: ${autoExecAllowed()}\n`);
});
