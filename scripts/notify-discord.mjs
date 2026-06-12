// Discord webhook notifier — supports per-channel routing. ESM module (Node 18+ global fetch).
//   import { sendDiscord } from './notify-discord.mjs';
//   const r = await sendDiscord('hello');                          // → DISCORD_WEBHOOK_BULL
//   const r = await sendDiscord('hello', { channel: 'go' });      // → DISCORD_WEBHOOK_GO
//   const r = await sendDiscord('hello', { channel: 'monopoly' });// → DISCORD_WEBHOOK_MONOPOLY
//   node scripts/notify-discord.mjs "your message"                // CLI (defaults to bull)
//
// Env vars: DISCORD_WEBHOOK_BULL, DISCORD_WEBHOOK_GO, DISCORD_WEBHOOK_MONOPOLY
//   Legacy DISCORD_WEBHOOK_URL is checked as fallback if no channel-specific var is set.
// sendDiscord NEVER throws: callers can fire-and-forget and keep running if Discord is down.
import { pathToFileURL } from 'node:url';

const WEBHOOK_RE = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i;

const CHANNEL_DEFAULTS = {
  bull:     { env: 'DISCORD_WEBHOOK_BULL',     username: 'Bull' },
  go:       { env: 'DISCORD_WEBHOOK_GO',       username: 'Go' },
  monopoly: { env: 'DISCORD_WEBHOOK_MONOPOLY', username: 'Mr Monopoly' },
};

/**
 * @param {string|object} message  Plain text, or a Discord JSON payload ({content}|{embeds}).
 * @param {{channel?:string, webhookUrl?:string, timeoutMs?:number, username?:string}} [opts]
 * @returns {Promise<{ok:boolean, status?:number, skipped?:boolean, error?:string}>}
 */
export async function sendDiscord(message, opts = {}) {
  const ch = CHANNEL_DEFAULTS[(opts.channel || 'bull').toLowerCase()] || CHANNEL_DEFAULTS.bull;
  const webhookUrl = opts.webhookUrl || process.env[ch.env] || process.env.DISCORD_WEBHOOK_URL;
  const { timeoutMs = 8000, username = ch.username } = opts;

  // NULL case — webhook not configured / malformed: skip gracefully so the caller keeps running.
  if (!webhookUrl || !WEBHOOK_RE.test(webhookUrl)) {
    return { ok: false, skipped: true, error: 'DISCORD_WEBHOOK_URL missing or not a valid Discord webhook URL' };
  }
  // NULL case — nothing to send.
  if (message == null || (typeof message === 'string' && message.trim() === '')) {
    return { ok: false, error: 'Empty message — nothing to send' };
  }

  const payload = typeof message === 'string'
    ? { username, content: message.slice(0, 2000) }   // Discord hard-limits content to 2000 chars
    : { username, ...message };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.status === 204 || res.ok) return { ok: true, status: res.status }; // Discord => 204 No Content
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `Discord ${res.status}: ${body.slice(0, 180)}` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// CLI entry — robust on Windows paths via pathToFileURL.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const msg = process.argv.slice(2).join(' ') || `Bull ping — ${new Date().toISOString()}`;
  const r = await sendDiscord(msg);
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}
