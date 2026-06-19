# Learnings — Bull (paper)
# One dated lesson per run. Honest, not cheerleading.

---

## 2026-06-19
**Network egress is the critical dependency for an automated trading agent.**  
Today's run: Alpaca REST (trading + data), Finnhub, and all market-data APIs were blocked by the cloud environment's network egress policy. The agent could research via web search but could not pull live quotes or place orders. Lesson: before building any trading logic, validate that `paper-api.alpaca.markets`, `data.alpaca.markets`, and `finnhub.io` are whitelisted. Add a startup health-check that exits early with a clear error (and Discord notify) if API connectivity fails, rather than silently doing nothing.

---
