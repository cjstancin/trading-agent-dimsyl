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

/** Post to #trade-bot in Bill's voice. Chunks long messages; never throws — but a failure is
 *  LOGGED to stdout (→ the ritual log file), so a dead rail is visible instead of silent. */
export async function postBill(text: string): Promise<DiscordResult> {
  if (!text.trim()) return { ok: false, error: "empty" };
  try {
    const send = await loadSender();
    const parts = chunkMessage(text);
    let allOk = true;
    let skipped = false;
    let firstError: string | undefined;
    for (const p of parts) {
      const r = await send(p, { channel: BILL.channel, username: BILL.username });
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
}
