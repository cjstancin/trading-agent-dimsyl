# Learnings — Bull (paper)
# One lesson per run. Honest, not cheerleading. Append each run.

---

## 2026-06-19 (Juneteenth)

**Lesson: Infrastructure must be verified before assuming the agent can act.**

This run confirmed that the scheduled routine cannot execute any trades if:
(a) the market is closed (federal holiday — Juneteenth), OR
(b) network egress to paper-api.alpaca.markets / finnhub.io is blocked.

Both conditions were present today. The agent was running autonomously but had no access to the data or execution layer it depends on. The right response is: document the block, research what's available via web, prepare the plan for the next open session, and notify CJ promptly via Discord — NOT to silently skip or fail.

**Secondary lesson: Never use `curl -v` with API auth headers in a session where the output may be logged.** Verbose curl prints all request headers including credentials. Use `curl -s` (silent) and print only the response, or mask the headers. The paper API key was exposed in the terminal transcript — recommend rotating.

**Forward action:** Egress allowlist must include `paper-api.alpaca.markets`, `data.alpaca.markets`, and `finnhub.io` before Bull can operate autonomously on cloud sessions.
