# Bill Agent — Setup (paper trading specialist, runs on the VPS via systemd timers)

Same Agent SDK template as Go, scoped to the trading specialist. Bill loads his rulebook from `Trading-Agent/CLAUDE.md`, reads the **Alpaca PAPER** account read-only, and posts a pre-market brief to **#trade-bot** as "Bill".

## Safety posture
- **Paper only.** `src/alpaca.ts` refuses any base URL that isn't `https://paper-api.alpaca.markets`.
- **Read-only runtime.** The agent has no order/shell tools and a runtime override forbidding execution. Pulling account/positions is deterministic (done by the script, not the model). **No orders are placed by this agent.** Paper-order execution stays a separate, human-gated step we add later on purpose.

## What's here
- `src/agent.ts` — the runtime (mirror of Go's): Bill brain + restricted tool belt + read-only override.
- `src/alpaca.ts` — read-only Alpaca PAPER client (account / positions / open orders), paper-endpoint-guarded.
- `src/run-premarket.ts` — the first ritual: paper snapshot → agent analyzes → brief to #trade-bot.
- `src/agent-cli.ts` — `npm run ask -- "..."` to query Bill directly.

## One-time setup
```
cd Trading-Agent\agent
npm install
```
Copy `.env.example` → `.env` and fill in `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_BULL`, and your **Alpaca PAPER** keys (`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL=https://paper-api.alpaca.markets`).

Sanity: `npm run typecheck` → `npm run ask -- "summarize my paper book"`.

## Run the pre-market brief
```
npm run premarket
```
Returns JSON `{ ok, posted, paperConnected, costUsd, numTurns }`. If `paperConnected:false`, check the Alpaca keys — the brief still posts and says the book is "not connected".

## Scheduling (VPS systemd timers)
Bill runs on the VPS under systemd timers (Mon–Fri, US/Eastern) — no longer a local PC task:
- `bill-open` — ~9:30 ET: pre-market brief → scan → execute (`agent/run-open.sh`).
- `bill-mid` — ~12:30 ET: re-scan → execute (`agent/run-mid.sh`).
- `bill-close` — ~16:00 ET: reconcile → refresh → journal → EOD report (`agent/run-close.sh`).
- `bill-heartbeat` — every ~5 min during market hours: monitoring beat to SAMS (`npm run heartbeat`), so the Port shows Bill online + monitoring between fires.

Each `run-*.sh` `cd`s into `agent/` and chains the npm scripts above, logging to `agent/logs/`.

## Next for Bill (deliberately not in this build)
- A **gated execution ritual**: read `Signals/approved-cycle.md`, place **paper** orders with stops per the rulebook, journal + commit. This gets its own opt-in + SUCCESS/FAIL/NULL tests before it ever runs unattended.
