// Enterprise self-test for the Discord notifier: a SUCCESS, a FAIL, and NULL cases.
//   node scripts/test-notify.mjs
// SUCCESS only really posts if DISCORD_WEBHOOK_URL is set in env; otherwise it asserts a graceful skip.
import { sendDiscord } from './notify-discord.mjs';

// Well-formed but fake webhook (passes format check, Discord rejects it / or network is blocked).
const VALID_FMT = 'https://discord.com/api/webhooks/123456789012345678/' + 'A'.repeat(60);

const cases = [
  {
    name: 'NULL — webhook not configured',
    run: () => sendDiscord('hi', { webhookUrl: '' }),
    ok: r => r.skipped === true && r.ok === false,
  },
  {
    name: 'NULL — empty message',
    run: () => sendDiscord('   ', { webhookUrl: VALID_FMT }),
    ok: r => r.ok === false && r.skipped !== true && /empty/i.test(r.error || ''),
  },
  {
    name: 'FAIL — well-formed but invalid/unreachable webhook',
    run: () => sendDiscord('should fail', { webhookUrl: VALID_FMT, timeoutMs: 6000 }),
    ok: r => r.ok === false && r.skipped !== true,
  },
  {
    name: 'SUCCESS — real webhook from env',
    note: process.env.DISCORD_WEBHOOK_URL ? 'env set — really sending' : 'env NOT set — expecting graceful skip',
    run: () => sendDiscord(`Bull self-test ${new Date().toISOString()}`),
    ok: r => process.env.DISCORD_WEBHOOK_URL ? r.ok === true : r.skipped === true,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  let r;
  try { r = await c.run(); } catch (e) { r = { ok: false, error: 'threw: ' + e.message }; }
  const good = !!c.ok(r);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? '  [' + c.note + ']' : ''}`);
  console.log(`        -> ${JSON.stringify(r)}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
