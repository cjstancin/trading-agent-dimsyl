// Bull v2 — INSIDER POLL ritual (every 2–5 min, 06:00–22:05 ET weekdays). One Atom pass:
//   shouldPollNow gate → pollOnce (fetch feed, process new accessions) → re-detect clusters →
//   any NEW qualifying cluster posts "signal tonight, entry next open". The systemd timer owns the
//   cadence; pollDelaySeconds (config jitter) is for a future self-scheduling loop — this entry
//   runs exactly one pass and exits.
import { d9str } from "../decimal.js";
import { pollOnce, shouldPollNow } from "../sleeves/insider/ingest.js";
import type { EdgarPort as InsEdgarPort } from "../sleeves/insider/ports.js";
import { scanNewInsiderSignals } from "./insider-signals.js";
import { step, type CoreDeps, type StepResult } from "./support.js";

export interface InsiderPollDeps extends CoreDeps {
  insEdgar: InsEdgarPort;
  weekday: () => number;   // ET weekday (0=Sun … 6=Sat)
  hhmm: () => string;      // ET wall clock "HH:MM"
}

export interface InsiderPollResult {
  ok: boolean;
  skipped?: string;
  processed: number;
  errors: number;
  newSignals: number;
  steps: StepResult[];
}

export async function runInsiderPollRitual(deps: InsiderPollDeps): Promise<InsiderPollResult> {
  const { db, eff, today, post } = deps;
  const steps: StepResult[] = [];
  const out: InsiderPollResult = { ok: true, processed: 0, errors: 0, newSignals: 0, steps };

  if (deps.mode === "off") return { ...out, skipped: "mode=off" };
  if (!shouldPollNow(deps.weekday(), deps.hhmm())) {
    return { ...out, skipped: `outside poll window (${deps.hhmm()} ET, weekday ${deps.weekday()})` };
  }

  await step(steps, post, "insider-poll", async () => {
    const results = await pollOnce(db, deps.insEdgar, eff.config.insider.cluster);
    out.processed = results.filter((r) => r.status === "processed").length;
    out.errors = results.filter((r) => r.status === "error").length;
    const dead = results.flatMap((r) => r.deadClusters ?? []);
    if (dead.length) {
      await post(`⚠️ [Insider] 4/A amendment killed ${dead.length} cluster(s): ${dead.join(", ")} — live positions (if any) got a thesis-review flag, never an auto-sell.`);
    }
    if (results.some((r) => r.status === "processed" && (r.qualifyingBuys ?? 0) > 0)) {
      const fresh = scanNewInsiderSignals(db, eff.config.insider.cluster, today, eff.version);
      out.newSignals = fresh.length;
      for (const c of fresh) {
        await post(`🐂 [Insider] cluster signal ${c.symbol} — ${c.participants.length} insiders, $${d9str(c.aggregate9)} aggregate (window ${c.windowStart}→${c.windowEnd}). Signal tonight, entry next open.`);
      }
    }
    if (out.errors) await post(`⚠️ [Insider] poll: ${out.errors} accession(s) errored (retryable — next pass or the nightly index takes another swing).`);
    return `processed ${out.processed}, errors ${out.errors}, new signals ${out.newSignals}`;
  });

  out.ok = steps.every((s) => s.ok);
  return out;
}
