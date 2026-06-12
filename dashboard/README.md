# Bull Dashboard — deploy to a free Netlify subdomain

A static, read-only dashboard. It fetches `data/status.json` (published by the cloud routine) and renders paper equity, P&L vs S&P, positions, the Project-1 signal queue, and recent trades. **No keys live here** — it only displays published data.

## What the agent publishes
The Close routine writes `Trading-Agent/dashboard/data/status.json`. **The committed `data/status.json` is itself the schema + a live sample** — the agent overwrites it each run, keeping the same keys and setting `"isSample": false`.

Top-level keys the dashboard reads:
- `updated`, `isSample`, `profile`, `regime`
- `equity`, `cash`, `dayPnlPct`, `monthPnlPct`, `vsSpyPct`
- `stats`: `{ winRate, maxDrawdownPct, bestDayPct, sharpe }`
- `equityCurve` / `spyCurve`: arrays of `{ t, v }`
- `positions`: `{ ticker, name, type, qty, entry, stop, last, mktValue, pctEq, pnl, pnlPct, days, rr, sector, thesis, spark[] }`
- `signals`: `{ ticker, dir, score, entry, stop, target, size, catalyst, thesis }`
- `trades`: `{ date, ticker, side, qty, price, status, realized, grade, note }`
- `movers`: `{ risers[], fallers[], biggest[], unusualVol[] }` each `{ ticker, chgPct, vol }`
- `tickers`: map of `SYM → { name, last, chgPct, spark[], thesis }` (powers the per-ticker pages)

Every ticker in any table is clickable → opens its ticker page (chart, position, thesis, external quote link). No keys live in this folder.

## Deploy (free, ~10 min) — you do this in your accounts
1. Put the `Trading-Agent/` folder in a **GitHub repo** (the same repo the remote routine uses).
2. In **Netlify** → Add new site → Import from Git → pick the repo.
3. **Base directory:** `Trading-Agent/dashboard` · **Publish directory:** `Trading-Agent/dashboard` · **Build command:** leave empty (it's static).
4. Deploy. You'll get a `random-name.netlify.app` URL.
5. **Custom subdomain:** Site settings → Domain management → add `trading.cjstancin.com` → add the CNAME record Netlify shows you at your DNS host. Free SSL is automatic.
6. Every time the routine commits a new `status.json` to the repo, Netlify redeploys automatically — the dashboard updates itself.

## Privacy note
If you don't want positions public, either keep the Netlify site password-protected (Site settings → Access control), or publish only non-sensitive fields. Never put API keys in this folder.
