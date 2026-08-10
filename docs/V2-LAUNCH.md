# Bull v2 — launch-day runbook

> Design §11: build fully → validate offline → **ONE launch day**, all sleeves, full-auto, one clean
> 12-month clock. Units are installed DISABLED; this document is the flip. The live gate (12 months
> beating SPY TR with realized max DD ≤ 15%) starts at the first equity mark.

## 0. Pre-launch — CJ's gates (nothing below runs without these)

1. **Archive v1** (while the OLD account keys still work): from `/home/cj/bull/agent`
   `npx tsx -e "import('./src/alpaca.js').then(async a => console.log(JSON.stringify(await a.getActivities('FILL'))))" > ../archive/v1-fills-final.json`
   Commit the archive. The v1 paper account is never reset — it stays as history.
2. **Fresh Alpaca paper account** (dashboard step, CJ only; up to 3 paper accounts allowed):
   create new, note the $5,000 reset amount (set custom equity $5,000 in the dashboard when
   creating/resetting the NEW account — never the v1 account).
3. **Account config** (paper trading API, new keys):
   `PATCH /v2/account/configurations {"max_margin_multiplier":"1","no_shorting":true,"dtbp_check":"both"}`
   Verify with a GET before proceeding.
4. **Env on the VPS** (`/home/cj/bull/agent/.env` — CJ writes keys himself, never through a transcript):
   - `ALPACA_API_KEY` / `ALPACA_API_SECRET` — the NEW paper keys (PK-prefix check prints at boot)
   - `BULL_CONTROL_TOKEN` — console mutations (mint fresh)
   - `BULL_LEI_STAGE_FILE` — path to the LEI payload on this box; then verify the stage VOCABULARY
     and journal a `book.leiDial.stageMap` config amendment mapping LEI's real stage names →
     engage/caution/pullback (unmapped = treated stale → SPY 200-DMA fallback, flagged)
   - `EDGAR_USER_AGENT` (defaults exist), optional `OPENFIGI_API_KEY`
   - `DISCORD_WEBHOOK_BULL` (already live from v1)

## 1. Validation — must be ALL green on the box

```bash
cd /home/cj/bull && git pull --ff-only && cd agent && npm ci && npm test
```
Full v1+v2 chain (typecheck + 26 v1 suites + 13 v2 suites). Any red = no launch.

Live-read smoke (no orders): `npx tsx -e "import('./src/v2/broker.js').then(async b => console.log(await b.alpacaReadPort.getAccount()))"` — confirms the NEW keys + paper host assert.

## 2. Seed + first reconcile

```bash
npm run v2:launch-init     # verifies broker cash == $5,000, seeds the settled-cash ledger (idempotent)
npm run mode auto          # full-auto from day one (design decision #25) — CJ's explicit flip
```
(Halts loudly if Alpaca cash ≠ $5,000 — it never "adjusts". Mode stays whatever you set; rituals
compute-but-don't-place in `gated`.)

## 3. Flip — the one launch day (a Monday, per the design)

```bash
sudo /home/cj/bull/agent/systemd/v2/install-v2.sh
sudo systemctl enable --now bill2-{morning,morning2,insider-poll,evening,weekly,anchor-filing,statement}.timer bill2-console.service
```
Old `bill-*` v1 timers STAY disabled. Console: Caddy/tailnet route → `http://127.0.0.1:4326`
(open with `/#token=<BULL_CONTROL_TOKEN>`).

First-day watch list (loud failure modes, all posted to #trade-bot):
- morning ritual: reconcile clean, dial resolved (or flagged fallback), anchor initial build
  (~18 buys through the gateway; settled-cash refusals surface as skip notes and re-fire next rebuild)
- momentum: first month-end signals run on the next month boundary (first-day buys draw settled cash;
  `feed=sip` historical bars 403 = LOUD empty-universe refusal, never silent mispricing)
- insider poll: first live EDGAR parse (watch for parser drift vs fixtures)
- evening: first equity mark = the 12-month clock's first tick

## 4. Rollback

`systemctl disable --now 'bill2-*'` — or engage the kill-switch in the console (halts every order
path via `halt:book`; state survives restarts). The ledger DB (`agent/runtime/v2/bull.db`) is the
performance truth — back it up before any manual surgery, never edit it by hand.

## Standing rails (non-negotiable, enforced in code)
Paper-only host assert in every dispatch · sizing never reads buying_power · −25% floor overrides
any model output · reallocation on schedule only · mass liquidation (brake tier 3) is CJ's click.
