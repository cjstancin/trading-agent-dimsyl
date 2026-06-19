# Learnings — Bull (paper)
# One dated lesson per run. Honest, not cheerleading. Archive monthly.

---

## 2026-06-19
**Lesson: Remote execution environments need egress allowlists for every external API.**
The Alpaca paper API (`paper-api.alpaca.markets`) and Finnhub (`finnhub.io`) are both blocked by the container's network egress policy. All research and sizing is done, candidates are ready (AVGO + NVDA), but execution is impossible without CJ adding these hosts to the egress allowlist. This is an infrastructure gap, not a trading mistake — but it means every day without the fix is a day of cash drag vs SPY. File the fix request, don't just log it and forget.

**Action for CJ**: In the Claude Code remote environment settings, add `paper-api.alpaca.markets` and `finnhub.io` to the network egress allowlist. Documentation: https://code.claude.com/docs/en/claude-code-on-the-web

---

## 2026-06-14 (initial setup)
**Lesson: Start with a clean process before firing live orders.**
Profile reined in: quality names only (≥$10, real revenue), no leveraged ETFs. The aggressive posture is now expressed through concentration + conviction in good names (AVGO, NVDA, AMD tier), not through speculative leverage. This is the right move — volatility comes from the business, not the instrument structure.
