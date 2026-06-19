# Learnings — Bull (paper)
# One honest lesson per dated entry. No cheerleading.

---

## 2026-06-19
**Network egress blocks live API access in the cloud execution environment.**
Alpaca, Finnhub, and Discord are all blocked by the egress policy (HTTP 403 — "Host not in allowlist").
This means remote-scheduled runs *cannot confirm equity, place orders, or post to Discord without
the environment being configured with the correct egress allowlist.*
**Action needed:** CJ should add `paper-api.alpaca.markets`, `data.alpaca.markets`,
`api.finnhub.io`, and `discord.com` (or `discordapp.com`) to the network egress allow-list
in Claude Code on the web → Environment settings. Until then, every cloud run is research-only.

**Separately:** ALPACA_BASE_URL env var already includes `/v2`, so API calls should omit the
`/v2` prefix: use `${ALPACA_BASE_URL}/account` not `${ALPACA_BASE_URL}/v2/account`.

**On MRVL S&P inclusion trade:** The "buy the inclusion catalyst" playbook has real edge,
but the entry window is tight — the forced buying happens on June 22 and often peaks that day.
The risk-reward shrinks the closer you get to the event with the stock already up big.
Next time: get in earlier (when the announcement was made on June 6) for the better R:R.
