// Bull v2 — EVENING ritual (Mon–Fri ~16:30 ET). The close-of-day bookkeeping + judgment sequence:
//   market-day gate → replay fills → equity mark (missing prices fall back to the prior mark) →
//   benchmark closes + per-sleeve marks → insider nightly (daily-index reconcile → new-signal scan
//   → shadow CARs → exits pass) → thesis-check runner over pending stop_fired events → corporate-
//   actions nightly poll (plan stored for the morning) → judgment outcome checkpoints → summary.
// Same rails as the morning: step() around everything, trades only in mode "auto".
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, div9, type D9 } from "../decimal.js";
import { getState, setState, clearState } from "../db.js";
import type { BrokerPort, ReadPort } from "../broker.js";
import type { MarketDayCheck } from "../../market-calendar.js";
import { SLEEVES } from "../types.js";
import { replayFills } from "../reconcile.js";
import { addDays, ledgerPosition, ledgerPositions } from "../lots.js";
import { markEquity } from "../book/equity.js";
import { recordBench } from "../book/benchmarks.js";
import { recordExit } from "../book/watchlist.js";
import { placeOrder } from "../order-gateway.js";
import { runThesisCheck, type ThesisCheckInput } from "../judgment/thesis-check.js";
import { dueOutcomes, recordOutcome, PROXY_FOR } from "../judgment/counterfactual.js";
import type { LlmPort } from "../judgment/llm-port.js";
import type { Claim } from "../judgment/quarantine.js";
import { tradeNote, skipNote, escalationNote } from "../surfaces/notes.js";
import { reconcileDaily, type ProcessResult } from "../sleeves/insider/ingest.js";
import { runExits, readMeta } from "../sleeves/insider/exits.js";
import { updateShadowCars } from "../sleeves/insider/shadow.js";
import type { EdgarPort as InsEdgarPort, PricePort as InsPricePort, DailyBar as InsDailyBar } from "../sleeves/insider/ports.js";
import type { StopFiredEvent } from "../sleeves/wildcard/types.js";
import type { CorporateActionsPort } from "../book/corporate-actions.js";
import { nightlyCorpPoll } from "./corp-actions.js";
import { scanNewInsiderSignals } from "./insider-signals.js";
import {
  step, numToD9, sleeveNavFor9, priceMap9, avgEntryPrice9, queueApprovalRow, dtGuard,
  type CoreDeps, type StepResult, type DailyBarsFn, type AlpacaBarLike,
} from "./support.js";

export interface EveningDeps extends CoreDeps {
  broker: BrokerPort;
  read: ReadPort;
  marketDay: () => Promise<MarketDayCheck>;
  insEdgar: InsEdgarPort;
  insCarPrices: InsPricePort;
  corpPort: CorporateActionsPort;
  llm: LlmPort;
  dailyBars: DailyBarsFn;
}

export interface EveningResult {
  ok: boolean;
  skipped?: string;
  steps: StepResult[];
}

function insBars(bars: AlpacaBarLike[]): InsDailyBar[] {
  return bars.map((b) => ({ date: String(b.t).slice(0, 10), close9: numToD9(b.c), volume9: numToD9(b.v) }));
}

interface StopEvent {
  key: string;
  sleeve: "ins" | "wld";
  symbol: string;
  raw: string;
}

function pendingStopEvents(db: DatabaseSync): StopEvent[] {
  const rows = db.prepare(
    "SELECT key, value FROM state WHERE key LIKE 'ins:stop_fired:%' OR key LIKE 'wld:stop_fired:%'",
  ).all() as { key: string; value: string }[];
  return rows.map((r) => {
    const sleeve = r.key.startsWith("ins:") ? "ins" as const : "wld" as const;
    return { key: r.key, sleeve, symbol: r.key.slice(`${sleeve}:stop_fired:`.length), raw: r.value };
  });
}

export async function runEveningRitual(deps: EveningDeps): Promise<EveningResult> {
  const { db, eff, today, post, broker, read, latestPrice } = deps;
  const cfg = eff.config;
  const steps: StepResult[] = [];
  const tradesAllowed = deps.mode === "auto";
  const washDays = Number(cfg.ledger.washBlacklistDays);

  if (deps.mode === "off") return { ok: true, skipped: "mode=off", steps };
  const day = await deps.marketDay();
  if (!day.open) return { ok: true, skipped: day.reason, steps };

  // Sessions window (insider horizon math + T+1 settlement of replayed sells). Best-effort.
  let sessions: string[] = [];
  await step(steps, post, "sessions", async () => {
    sessions = await read.getSessions(addDays(today, -400), addDays(today, 14));
    return `${sessions.length} session(s)`;
  });

  // ---- 1 · replay fills into the tax + cash ledgers. -------------------------------------------
  await step(steps, post, "replay-fills", async () => {
    const r = await replayFills(db, read, { sessions: sessions.length ? sessions : undefined });
    if (r.untagged.length) {
      await post(escalationNote({
        kind: "untagged-fills",
        title: `${r.untagged.length} fill(s) with no resolvable sleeve — morning reconcile will halt the book`,
      }));
    }
    return `fills +${r.newFills}, disposals +${r.newDisposals}`;
  });

  // ---- 2 · equity mark (SGOV included; missing prices fall back to the previous mark). ---------
  let heldPrices = new Map<string, D9>();
  await step(steps, post, "equity-mark", async () => {
    heldPrices = await priceMap9(ledgerPositions(db).keys(), latestPrice);
    const dialRaw = getState(db, "dial:lei");
    const dialPos = dialRaw ? (JSON.parse(dialRaw) as { position: string }).position : undefined;
    const brakeTierRaw = getState(db, "brake:tier");
    const mark = markEquity(db, today, heldPrices, {
      ...(dialPos ? { dial: dialPos } : {}),
      ...(brakeTierRaw != null ? { brakeTier: Number(brakeTierRaw) } : {}),
    });
    if (mark.missingPrices.length) {
      await post(`⚠️ [Book] equity mark ${today}: no fresh price for ${mark.missingPrices.join(", ")} — previous mark's price used (flagged, never fabricated).`);
    }
    return `equity $${d9str(mark.equity9)} (${mark.positions.length} positions${mark.missingPrices.length ? `, ${mark.missingPrices.length} price-fallback` : ""})`;
  });

  // ---- 3 · benchmark closes + per-sleeve marks. ------------------------------------------------
  await step(steps, post, "benchmarks", async () => {
    const benchSyms = new Set<string>([
      String(cfg.benchmarks.book), String(cfg.benchmarks.mom), String(cfg.benchmarks.ins),
      ...(Array.isArray(cfg.benchmarks.anc) ? cfg.benchmarks.anc.map(String) : [String(cfg.benchmarks.anc)]),
    ]);
    const missing: string[] = [];
    for (const sym of benchSyms) {
      const p = await latestPrice(sym);
      if (p == null) missing.push(sym);
      else recordBench(db, today, sym, numToD9(p));
    }
    for (const s of SLEEVES) {
      recordBench(db, today, `sleeve:${s}`, sleeveNavFor9(db, eff, s, heldPrices));
    }
    return `benches ${benchSyms.size - missing.length}/${benchSyms.size}${missing.length ? ` (missing ${missing.join(",")})` : ""} + 4 sleeve marks`;
  });

  // ---- 4 · insider nightly: daily-index reconcile → new-signal scan → shadow CARs. -------------
  await step(steps, post, "insider-nightly", async () => {
    const rec = await reconcileDaily(db, deps.insEdgar, today, cfg.insider.cluster);
    const errs = rec.results.filter((r: ProcessResult) => r.status === "error").length;
    const fresh = scanNewInsiderSignals(db, cfg.insider.cluster, today, eff.version);
    for (const c of fresh) {
      await post(`🐂 [Insider] cluster signal ${c.symbol} — ${c.participants.length} insiders, $${d9str(c.aggregate9)} aggregate (window ${c.windowStart}→${c.windowEnd}). Signal tonight, entry next open.`);
    }
    const cars = await updateShadowCars(db, deps.insCarPrices, String(cfg.benchmarks.ins), today);
    return `index ${rec.indexed}, missed ${rec.missed}${errs ? `, errors ${errs}` : ""}, new signals ${fresh.length}, CARs touched ${cars}`;
  });

  // ---- 5 · insider exits pass (horizon / reversal / ATR stop events). --------------------------
  await step(steps, post, "insider-exits", async () => {
    if (!sessions.length) {
      await post(skipNote("ins", "(all)", "NO_SESSIONS", "calendar unavailable — horizon exits deferred to tomorrow"));
      return "no sessions";
    }
    if (!tradesAllowed) {
      await post(`⏸️ [Insider] mode=${deps.mode}: nightly exits pass skipped (it places orders) — horizons re-checked when mode=auto.`);
      return "gated";
    }
    const atr = cfg.wildcard.atrStop as { atrDays: number; multiple: number };
    const actions = await runExits(db, broker, {
      exit: cfg.insider.exit, washBlacklistDays: washDays, configVersion: eff.version,
      asOfDate: today, sessions,
      latestPrice9: async (s) => { const p = await latestPrice(s); return p == null ? null : numToD9(p); },
      bars: async (s) => insBars(await deps.dailyBars(s, Number(atr.atrDays) * 3 + 20)),
      atr: { days: Number(atr.atrDays), multiple: Number(atr.multiple) },
    });
    for (const a of actions) {
      if (a.action === "hold") continue;
      if (a.action === "stop-fired") {
        if (a.detail === "emitted") await post(`🛡️ [Insider] ${a.symbol} ATR stop fired — thesis-check queued (no auto-sell).`);
        continue;
      }
      if (a.place?.placed) {
        const px = await latestPrice(a.symbol);
        recordExit(db, {
          ts: new Date().toISOString(), sleeve: "ins", symbol: a.symbol,
          reason: a.action === "sell-horizon" ? "horizon" : "reversal",
          exitPrice9: px != null ? numToD9(px) : d9("0"), qty9: ledgerPosition(db, a.symbol),
        });
        await post(tradeNote({ sleeve: "ins", symbol: a.symbol, side: "sell", intent: "sell", reason: `${a.action}: ${a.detail ?? ""}` }));
      } else if (a.place) {
        await post(skipNote("ins", a.symbol, a.place.skipped ?? "REJECTED", a.place.detail));
      }
    }
    return `${actions.length} position(s) checked`;
  });

  // ---- 6 · thesis-check runner over pending stop_fired events. ---------------------------------
  await step(steps, post, "thesis-checks", async () => {
    const events = pendingStopEvents(db);
    if (!events.length) return "no pending events";
    let handled = 0;
    for (const ev of events) {
      const qty9 = ledgerPosition(db, ev.symbol);
      if (qty9 <= 0n) {
        clearState(db, ev.key);
        await post(`ℹ️ [${ev.sleeve}] stop event for ${ev.symbol} cleared — position already flat.`);
        continue;
      }
      const proxySym = PROXY_FOR[ev.sleeve] ?? "SPY";
      const proxyPx = await latestPrice(proxySym);
      if (proxyPx == null) {
        await post(skipNote(ev.sleeve, ev.symbol, "NO_PROXY_PRICE", `${proxySym} unpriced — thesis-check deferred to tomorrow`));
        continue;
      }
      let input: ThesisCheckInput | null = null;
      if (ev.sleeve === "wld") {
        const e = JSON.parse(ev.raw) as StopFiredEvent;
        const current = (await latestPrice(ev.symbol)) ?? Number(e.firedPrice);
        input = {
          sleeve: "wld", symbol: ev.symbol,
          entryPrice9: numToD9(e.entryPrice), currentPrice9: numToD9(current),
          stopPrice9: e.atrStop != null ? numToD9(e.atrStop) : d9(e.firedPrice),
          qty9,
          thesis: e.thesis,
          invalidation: `pre-written invalidation level ${e.invalidationLevel}; would change my mind: ${e.whatWouldChangeMyMind}`,
          claims: [] as Claim[], asOfDate: today, configVersion: eff.version,
          proxyPrice9: numToD9(proxyPx),
        };
      } else {
        const e = JSON.parse(ev.raw) as { ts: string; price9: string; stop9: string };
        const meta = readMeta(db, ev.symbol);
        const entry9 = avgEntryPrice9(db, "ins", ev.symbol);
        const current = await latestPrice(ev.symbol);
        input = {
          sleeve: "ins", symbol: ev.symbol,
          entryPrice9: entry9 ?? d9(e.price9),
          currentPrice9: current != null ? numToD9(current) : d9(e.price9),
          stopPrice9: d9(e.stop9), qty9,
          thesis: meta
            ? `Insider cluster ${meta.clusterId}: ${meta.participants.length} insider(s) bought within the window — conviction signal, ${meta.horizonTradingDays}-session horizon.`
            : `Insider cluster position (metadata missing).`,
          claims: [] as Claim[], asOfDate: today, configVersion: eff.version,
          proxyPrice9: numToD9(proxyPx),
        };
      }

      const v = await runThesisCheck(db, deps.llm, input);
      handled++;
      if (v.action === "sell_now") {
        if (!tradesAllowed) {
          await post(`⏸️ [${ev.sleeve}] mode=${deps.mode}: thesis-check says SELL ${ev.symbol} (${v.cls}) — not placed, event kept pending.`);
          continue;
        }
        const res = await placeOrder(db, broker, {
          owner: ev.sleeve, symbol: ev.symbol, intent: "sell", side: "sell", type: "market", tif: "day",
          qty9, estPrice9: input.currentPrice9, asOfDate: today, configVersion: eff.version, blacklistExempt: true,
        }, { washBlacklistDays: washDays, extraGuards: [dtGuard(eff)] });
        if (res.placed) {
          recordExit(db, {
            ts: new Date().toISOString(), sleeve: ev.sleeve, symbol: ev.symbol,
            reason: v.cls === "thesis_break" ? "thesis_break" : "stop",
            exitPrice9: input.currentPrice9, qty9,
          });
          clearState(db, ev.key);
          await post(tradeNote({
            sleeve: ev.sleeve, symbol: ev.symbol, side: "sell", intent: "sell",
            qty: d9str(qty9), reason: `thesis-check: ${v.cls}`,
            protection: `floor was ${d9str(v.floorPrice9)}`,
          }));
        } else {
          await post(skipNote(ev.sleeve, ev.symbol, res.skipped ?? "REJECTED", res.detail));
        }
      } else if (v.action === "escalate_hold") {
        queueApprovalRow(db, "thesis-escalation", `Thesis-check escalation: ${ev.symbol} (${v.cls})`, {
          sleeve: ev.sleeve, symbol: ev.symbol, cls: v.cls, votes: v.votes,
          corroborated: v.corroborated, floorPrice9: d9str(v.floorPrice9), notes: v.notes, verdictId: v.verdictId,
        });
        clearState(db, ev.key);
        await post(escalationNote({
          kind: "thesis-escalation",
          title: `${ev.symbol} [${ev.sleeve}] held with −25% floor $${d9str(v.floorPrice9)} — ${v.cls}`,
          detail: v.notes.join("; "),
        }));
      } else {
        clearState(db, ev.key);
        await post(`🧠 [${ev.sleeve}] ${ev.symbol}: thesis-check verdict ${v.cls} → HOLD with −25% floor $${d9str(v.floorPrice9)} (code-enforced).`);
      }
    }
    return `${handled}/${events.length} event(s) judged`;
  });

  // ---- 7 · corporate-actions nightly poll (plan stored for the morning). -----------------------
  await step(steps, post, "corp-actions-poll", async () => {
    const { plan, held } = await nightlyCorpPoll(db, deps.corpPort, { today });
    if (plan.unknown.length) {
      await post(escalationNote({
        kind: "corp-actions-unknown",
        title: `${plan.unknown.length} unclassifiable corporate action(s) on held names — surfaced, never guessed at`,
        detail: plan.unknown.map((u) => `${u.symbol}:${u.type}`).join(", "),
      }));
    }
    for (const ex of plan.exitBefore) {
      await post(`📅 [Book] ${ex.symbol} ${ex.type} effective ${ex.effectiveDate} — exit queued for the next morning ritual.`);
    }
    return `${held.length} held · exits ${plan.exitBefore.length}, splits ${plan.forwardSplits.length}, dividends ${plan.dividends.length}, unknown ${plan.unknown.length}`;
  });

  // ---- 8 · judgment outcome checkpoints (1/3/6-month counterfactuals). -------------------------
  await step(steps, post, "judgment-outcomes", async () => {
    const due = dueOutcomes(db, today);
    let recorded = 0;
    for (const o of due) {
      const pos = await latestPrice(o.symbol);
      const proxy = await latestPrice(PROXY_FOR[o.sleeve] ?? "SPY");
      if (pos == null || proxy == null) continue; // unpriceable tonight — stays due
      recordOutcome(db, o.verdictId, o.checkpoint, today, numToD9(pos), numToD9(proxy));
      recorded++;
    }
    return `${recorded}/${due.length} checkpoint(s) recorded`;
  });

  // ---- 9 · nightly summary note. ---------------------------------------------------------------
  await step(steps, post, "summary", async () => {
    const lines = steps.filter((s) => s.name !== "summary")
      .map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
    await post(`🌙 **Bill v2 evening — ${today}**\n${lines.join("\n")}`);
  });

  return { ok: steps.every((s) => s.ok), steps };
}
