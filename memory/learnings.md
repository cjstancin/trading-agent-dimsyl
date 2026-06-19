# Learnings — Bull (paper)
# One dated lesson per run. Honest. No cheerleading.

---

**2026-06-19** — First run that attempted live Alpaca execution. Blocked by egress policy. Lesson: the remote execution environment's network allowlist must include `paper-api.alpaca.markets` for the agent to function end-to-end. Without API access, research and planning can still run, but no orders can be placed. This is a configuration gap, not a trading mistake — but it means Bull has been unable to trade for 5 days (Jun 14→19) while SPY advanced ~3.3%. Opportunity cost of an unconfigured environment is real even in paper: −3.3% vs benchmark already on Day 1 of actual operation. Fix the egress; don't let operational setup failures turn into tracking error.

**2026-06-19** — Pre-earnings momentum plays carry asymmetric risk. MU is up 8.74% the day before its June 24 earnings. Last quarter MU beat spectacularly and still sold off. "Buy the rumor, sell the news" is a real dynamic in high-expectation setups. Decided to skip MU pre-earnings and wait for the post-earnings technical setup. Discipline over FOMO.
