// Twice-daily health check for Bull. Validates the published dashboard data and reports to Discord.
//   node scripts/health-check.mjs
// Schedule this twice a day (see CLAUDE.md → "Twice-daily health check"). Exit code: 0 healthy, 1 needs attention.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendDiscord } from './notify-discord.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STATUS = join(here, '..', 'dashboard', 'data', 'status.json');

const usd = n => (n == null ? '—' : '$' + Math.round(n).toLocaleString());
const pct = n => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%');

async function check() {
  const problems = [];
  let data = null;
  try {
    data = JSON.parse(await readFile(STATUS, 'utf8')); // FAIL path: missing file / invalid JSON throws
  } catch (e) {
    problems.push('status.json missing or invalid JSON: ' + e.message);
  }
  if (data) {
    if (data.equity == null) problems.push('no equity field');                 // NULL path
    if (!Array.isArray(data.positions)) problems.push('positions[] missing');
    if (data.isSample) problems.push('still SAMPLE data — the routine has not published real data yet');
  }

  const healthy = problems.length === 0;
  const head = healthy ? '🟢 Bull health OK' : '🟠 Bull health needs attention';
  const lines = data
    ? [`Equity ${usd(data.equity)} · Day ${pct(data.dayPnlPct)} · Month ${pct(data.monthPnlPct)}`,
       `Bot ${(data.bot && data.bot.status) || '—'} · profile ${data.profile || '—'}`]
    : ['No dashboard data could be read.'];
  if (problems.length) lines.push('Issues: ' + problems.join('; '));

  const sent = await sendDiscord(`**${head}** — ${new Date().toISOString()}\n${lines.join('\n')}`);
  console.log(JSON.stringify({ healthy, problems, discord: sent }, null, 2));

  // Fail the run if data is unhealthy, or if Discord was configured yet the send failed.
  const discordBroken = sent.ok === false && sent.skipped !== true;
  process.exitCode = (healthy && !discordBroken) ? 0 : 1;
}
check();
