// Bull v2 — Discord rail (design §9). Rides the existing fleet notifier (scripts/notify-discord.mjs
// → DISCORD_WEBHOOK_BULL → #trade-bot) with Bill's voice. sendDiscord never throws; every surface
// here is fire-and-forget so a Discord outage can never break a trading ritual. Messages over the
// 2000-char hard limit are CHUNKED on line boundaries, never truncated mid-thought (the v1 rail
// truncated; the digest is the surface CJ actually reads — it must arrive whole).
export const BILL = { username: "Bill the Bull 🐂", channel: "bull" as const };

export interface DiscordResult { ok: boolean; skipped?: boolean; parts?: number; error?: string; }

async function loadSender(): Promise<(msg: string, opts: Record<string, unknown>) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>> {
  // Repo layout: agent/src/v2/surfaces/ → four levels up to the repo root, where scripts/ lives.
  // (Three levels — agent/scripts/ — does not exist; the wrong depth here silenced every post
  // from launch day until 2026-08-23 because the catch below swallowed the resolution error.)
  const mod = await import("../../../../scripts/notify-discord.mjs" as string);
  return mod.sendDiscord;
}

/** Split on line boundaries into ≤1900-char parts (headroom under Discord's 2000 hard limit). */
export function chunkMessage(text: string, max = 1900): string[] {
  const lines = text.split("\n");
  const parts: string[] = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur ? cur + "\n" + line : line;
    if (candidate.length > max && cur) { parts.push(cur); cur = line; }
    else if (candidate.length > max) { parts.push(line.slice(0, max)); cur = line.slice(max); } // pathological single line
    else cur = candidate;
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---- 429 hardening (2026-09-01, broken-week repair). The 08-24 mismatch morning burst ~12 posts
// at the webhook and Discord 429'd TEN of them — including the skip notes CJ needed — because
// every send was fire-and-forget with no pacing and no retry. Rules now:
//   · ALL posts serialize through one module-level queue with a minimum inter-send gap, so a
//     ritual's burst can't stampede the webhook.
//   · A 429 reply is retried up to RETRY_MAX times, honoring Discord's own retry_after.
//   · Everything else keeps the old contract: never throws, failures logged to stdout.

const MIN_GAP_MS = 400;
const RETRY_MAX = 3;

type SendFn = (msg: string, opts: Record<string, unknown>) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;

let queueTail: Promise<unknown> = Promise.resolve();
let lastSendMs = 0;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Discord's 429 body carries retry_after in SECONDS ("retry_after": 0.3). null = not a 429. */
export function parseRetryAfterMs(error: string | undefined): number | null {
  if (!error || !/429/.test(error)) return null;
  const m = /retry_after"?\s*[:=]\s*"?([\d.]+)/.exec(error);
  const secs = m ? parseFloat(m[1]) : 1;
  return Math.ceil((Number.isFinite(secs) && secs > 0 ? secs : 1) * 1000);
}

/** One paced send with 429 retry. Exported for tests (sleepFn/now injectable). */
export async function sendPaced(
  send: SendFn, part: string, opts: Record<string, unknown>,
  sleepFn: (ms: number) => Promise<void> = realSleep, now: () => number = Date.now,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  for (let attempt = 1; ; attempt++) {
    const gap = lastSendMs + MIN_GAP_MS - now();
    if (gap > 0) await sleepFn(gap);
    const r = await send(part, opts);
    lastSendMs = now();
    if (r.ok || r.skipped) return r;
    const retryMs = parseRetryAfterMs(r.error);
    if (retryMs == null || attempt >= RETRY_MAX) return r;
    await sleepFn(retryMs + 150); // headroom over Discord's own ask
  }
}

/** Post to #trade-bot in Bill's voice. Chunks long messages; serializes + paces all sends and
 *  retries 429s; never throws — but a terminal failure is LOGGED to stdout (→ the ritual log
 *  file), so a dead rail is visible instead of silent. */
export function postBill(text: string): Promise<DiscordResult> {
  const run = async (): Promise<DiscordResult> => {
    if (!text.trim()) return { ok: false, error: "empty" };
    try {
      const send = await loadSender();
      const parts = chunkMessage(text);
      let allOk = true;
      let skipped = false;
      let firstError: string | undefined;
      for (const p of parts) {
        const r = await sendPaced(send, p, { channel: BILL.channel, username: BILL.username });
        if (r.skipped) skipped = true;
        if (!r.ok) { allOk = false; firstError ??= r.error; }
      }
      if (!allOk) console.warn(`[discord] post ${skipped ? "skipped (webhook unset/invalid)" : "failed"}${firstError ? `: ${firstError}` : ""}`);
      return { ok: allOk, skipped, parts: parts.length };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[discord] sender unavailable: ${error}`);
      return { ok: false, error };
    }
  };
  const p = queueTail.then(run, run);
  queueTail = p.catch(() => {});
  return p;
}
