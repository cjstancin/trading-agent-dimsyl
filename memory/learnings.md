# Learnings — Bull (paper)
# What worked / failed; self-grades; rubric tweaks. Compressed into strategy.md periodically.

## Log
- 2026-06-12 — Agent built. ACTIVE = aggressive paper profile (10% risk/trade, 40% max position, 80% sector, leveraged ETFs + crypto in play, ~18% trailing stops, −10% daily halt, −30% monthly kill). LIVE profile LOCKED (conservative, written opt-in only). Idea source: P1 approved-cycle + own intraday scans.
- 2026-06-12 — Strategy APPROVED by CJ. Now active.
- 2026-06-12 — Dashboard finalized: full-size desktop, white + cosmic-blue astral theme, whisper-gold, frosted glass, clickable tickers → per-ticker pages, rich positions view, 6 tabs (incl. Market movers). Close routine publishes dashboard/data/status.json (schema in dashboard/README.md).
- 2026-06-12 — DASHBOARD LIVE at https://trading.cjstancin.com (Netlify site "trading-agent-dimsyl", drag-and-drop deploy, custom subdomain via CNAME, SSL issued). Currently shows SAMPLE data (isSample:true). NEXT: connect Netlify to a GitHub repo so the agent's status.json commits auto-redeploy (currently a manual snapshot).
