// John von Neumann's PORT job — Post-close Combined-book Risk & correlation review (read-only, propose-only).
// Reads the EXISTING paper-trade position JSON already written under /home/cj/bull (Bill's dashboard book,
// and Hakari's once present) + Shiro's qualitative notes if any — NO broker calls. Runs the pure aggregation
// in port-review.ts (net long/short, single-name + sector concentration, cross-trader crowding, combined
// drawdown vs a notional risk budget, 0–3 proposals), posts a short Discord digest as "John von Neumann",
// and heartbeats SAMS as agent 'mercury'. Place NO orders. Run: `npm run port:review`. The Mon–Fri 16:15 ET
// calendar-aware systemd timer is wired by ops — this just exposes the script.
//
// Sources (each overridable via env; a missing file is reported as a gap, never fabricated):
//   Bill   — BILL_BOOK   (default dashboard/data/status.json)        { equity, risk.peakEquity, positions[] }
//   Hakari — HAKARI_BOOK  (default dashboard/data/hakari-status.json) same shape; absent until Hakari ships
//   Shiro  — SHIRO_NOTES  (default memory/shiro-notes.md)            free-text research notes (context only)
import "./load-env.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installSafetyNet } from "./http-utils.js";
import { getMode } from "./mode.js";
import { portReview, DEFAULT_PORT_CONFIG, type Book, type PortReview } from "./port-review.js";
import { samsReport, SAMS_URL } from "./sams-report.js";

installSafetyNet("vonneumann-port-review");

const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const resolve = (envVar: string, rel: string): string => process.env[envVar] || fileURLToPath(new URL(rel, import.meta.url));

// mode=off means the floor is dormant — skip cleanly (mirrors run-eod-report's gate).
if (getMode() === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

/** Read one trader's book JSON into a Book. A missing file ⇒ present:false (a gap); a flat file ⇒ present:true. */
function readBook(trader: string, envVar: string, rel: string): Book {
  const path = resolve(envVar, rel);
  if (!existsSync(path)) return { trader, present: false, positions: [] };
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const positions = (Array.isArray(s.positions) ? s.positions : []).map((p: Record<string, any>) => ({
      symbol: String(p.t ?? p.symbol ?? "?"),
      qty: num(p.qty),
      marketValueUsd: num(p.mktVal ?? p.market_value ?? p.marketValue ?? p.marketValueUsd),
      unrealizedPlPct: p.unrealPct ?? p.unrealizedPlPct ?? null,
      sector: p.sector ?? null,
    }));
    return {
      trader, present: true,
      equityUsd: num(s.equity ?? s.equityUsd),
      peakEquityUsd: num(s.risk?.peakEquity ?? s.peakEquity ?? s.equity ?? s.equityUsd),
      positions,
    };
  } catch {
    // Corrupt/unreadable file is a gap, not a fabricated book.
    return { trader, present: false, positions: [] };
  }
}

/** Read Shiro's notes (context only) — last few non-empty lines, or null if absent. */
function readShiroNotes(): string | null {
  const path = resolve("SHIRO_NOTES", "../../memory/shiro-notes.md");
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines.slice(-4).join(" · ") : null;
  } catch { return null; }
}

const books: Book[] = [
  readBook("Bill", "BILL_BOOK", "../../dashboard/data/status.json"),
  readBook("Hakari", "HAKARI_BOOK", "../../dashboard/data/hakari-status.json"),
];
const shiro = readShiroNotes();
const review = portReview(books, DEFAULT_PORT_CONFIG);

const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

/** Build the Discord digest (plain text, ≤2000 chars). */
function digest(r: PortReview): string {
  const L: string[] = [];
  L.push(`⚓ PORT Review — ${today}`);

  // Which books were in scope (✅ present, ⚠️ missing).
  const scope = books.map((b) => `${b.trader} ${b.present ? "✅" : "⚠️ (not present)"}`)
    .concat(shiro ? ["Shiro notes ✅"] : []).join(" · ");
  L.push(`📚 Books: ${scope}`);

  if (r.booksReviewed.length === 0) {
    L.push("No books found — nothing to review. (Reported as a gap, not estimated.)");
    return L.join("\n");
  }

  const e = r.exposure;
  L.push(`📊 Combined: net ${usd(e.netUsd)} ${e.netUsd < 0 ? "short" : "long"} (${e.netPctEquity}% of equity) · gross ${usd(e.grossUsd)} · ${e.positions} positions across ${r.booksReviewed.length} book(s)`);

  const top = r.singleName[0];
  const topSec = r.sector.find((s) => s.sector !== "Unknown") ?? r.sector[0];
  L.push(`🎯 Concentration: ${top ? `top name ${top.symbol} ${top.pctOfGross}% (cap ${DEFAULT_PORT_CONFIG.singleNameCapPct}%)` : "—"}${topSec ? ` · top sector ${topSec.sector} ${topSec.pctOfGross}% (cap ${DEFAULT_PORT_CONFIG.sectorCapPct}%)` : ""}`);

  L.push(`🔁 Crowding: ${r.crowding.length ? r.crowding.map((c) => `${c.symbol} (${c.traders.join("+")}, ${c.pctOfGross}%)`).join(", ") : "none"}`);

  const d = r.drawdown;
  L.push(`📉 Drawdown: ${d.drawdownPct}% of combined peak · ${d.budgetUsedPct}% of ${usd(d.budgetUsd)} risk budget${d.overBudget ? " ⚠️ OVER BUDGET" : ""}`);

  if (r.proposals.length) {
    L.push(`🟡 Proposals (${r.proposals[0].tag}):`);
    r.proposals.forEach((p, i) => L.push(`  ${i + 1}. ${p.title} — ${p.detail}`));
  } else {
    L.push("🟢 No rebalancing proposals — combined book within risk limits.");
  }

  if (shiro) L.push(`🔬 Shiro: ${shiro}`);
  for (const n of r.notes) L.push(`ℹ️ ${n}`);

  return L.join("\n");
}

const text = digest(review);

// Discord digest — reuse the Bull webhook/notify pattern, posting as John von Neumann.
const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);
const posted = await sendDiscord(text, { channel: "bull", username: "John von Neumann" });

// SAMS heartbeat — agent 'mercury' in room 'bull' / 'Port'. ok when a book was reviewed, else idle.
const reviewed = review.booksReviewed.length;
const top = review.singleName[0];
const summary = reviewed
  ? `${reviewed} book(s), ${review.exposure.positions} pos, ${review.proposals.length} proposal(s)`
  : "no books to review";
const heartbeat = await samsReport("mercury", {
  name: "John von Neumann", kind: "manager", room: "bull", roomTitle: "Port", sprite: "vonneumann", theme: "trading",
  status: reviewed > 0 ? "ok" : "idle",
  loadScore: Math.min(1, review.proposals.length / DEFAULT_PORT_CONFIG.maxProposals) || (reviewed ? 0.15 : 0.05),
  metrics: {
    books: reviewed,
    positions: review.exposure.positions,
    netPctEquity: review.exposure.netPctEquity,
    topName: top?.symbol ?? null,
    topNamePct: top?.pctOfGross ?? 0,
    drawdownPct: review.drawdown.drawdownPct,
    proposals: review.proposals.length,
  },
  event: { type: review.proposals.length ? "warn" : "info", text: summary.slice(0, 60), level: review.proposals.length ? "warn" : "info" },
  lastRun: new Date().toISOString(),
});

console.log(JSON.stringify({
  ok: true,
  booksReviewed: review.booksReviewed,
  booksMissing: review.booksMissing,
  positions: review.exposure.positions,
  proposals: review.proposals.length,
  posted,
  heartbeat: { ...heartbeat, samsUrl: SAMS_URL },
}, null, 2));
if (!posted.ok && !posted.skipped) process.exitCode = 1;
