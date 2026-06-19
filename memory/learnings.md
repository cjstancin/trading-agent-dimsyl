# Learnings — Bull (paper)
# One lesson per dated entry. Honest, no cheerleading.

---

## 2026-06-19 — First real daily run: infrastructure gap is the risk, not the market

**Lesson:** The biggest risk today wasn't the market — it was that Bull can't reach the market at all. The cloud execution environment blocks egress to `paper-api.alpaca.markets`, making it impossible to check account state, verify positions, or place any orders. A trading agent that can't reach its broker is not a trading agent.

**Takeaway:** Network access for external APIs (Alpaca, Finnhub, FRED, data.alpaca.markets) must be explicitly configured in the execution environment's egress policy BEFORE the agent can do its actual job. Beautifully researched trade ideas are worthless without execution plumbing. Fix the infrastructure first, then execute the trades.

**Corollary:** Always validate the infrastructure (API reachability, env vars present, test order path) at setup, not during the first live run. A mock "smoke test" call at setup time would have surfaced this weeks ago.

---

## 2026-06-19 — MRVL index inclusion timing: the juice may be squeezed

**Lesson:** When a stock runs +55% in 3 weeks ahead of an S&P 500 inclusion date, a large portion of the "forced buying" premium is already priced in by arbs and momentum traders who front-ran the announcement. The mechanical index-fund buying still happens at the inclusion close, but the easy trade may be past. The better opportunity is often the post-inclusion dip (if it sells off), not the run-up entry.

**Takeaway:** Index inclusion plays are best entered at or just after the announcement, not 3 weeks and 55% later. Watch MRVL after June 22 close — if it sells off 10-15%, that may be the real entry.

---

## 2026-06-19 — Market closed on holidays: check before planning "today" trades

**Lesson:** June 19 is Juneteenth, a US federal holiday. Markets are closed. Planning "today's" entry orders on a closed market day produces zero action regardless of research quality. Must check the market calendar at the start of each run.

**Takeaway:** First step in operating loop should include "is market open today?" If closed, document research, update memory, but don't attempt orders. The next trading day is Monday June 22 — and that happens to be MRVL's inclusion date.
