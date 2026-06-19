# Learnings — Bull (paper)
# Dated lessons appended each run. Honest about mistakes. Used to improve future decisions.

---

## 2026-06-19

**1. Network egress blocks need to be fixed before autonomous trading can begin.**
The Alpaca paper API (`paper-api.alpaca.markets`) is not in the allowed egress list for this run environment. Every daily run will fail to place or read orders until this is resolved. Two separate issues found:
- (a) `paper-api.alpaca.markets` not in egress allowlist → 403 "host not in allowlist"
- (b) `ALPACA_BASE_URL` env var already includes `/v2` suffix, so naively appending `/v2/endpoint` produces `/v2/v2/endpoint` — double-pathing bug

**Fix needed:** Either add the host to egress settings (preferred), or switch to a proxy/webhook approach that's already in the allowlist.

**2. A market holiday is an opportunity to research, not an excuse to skip journaling.**
June 19 (Juneteenth) — markets closed. No fills possible. But research can still be done and orders can still be queued for Monday. Used today to run full research cycle and prepare GTC orders.

**3. MU pre-earnings setup is one of the cleaner high-conviction plays in the paper account.**
Multiple strategy triggers aligned simultaneously: new ATH breakout, #1 momentum in sector, near-term dated catalyst (June 24 earnings), HBM sold-out supply thesis, massive analyst upgrade wave. Pre-earnings entries carry "sell the news" risk, but the fundamental setup (960% EPS growth, AI memory monopoly positioning) is extraordinary. Sized to survive a 20% gap-down.

**4. Tracking vs-SPY from day one is critical for accountability.**
Paper has been in cash since inception June 12. SPY is up ~3% in that time. Being fully in cash was not an active decision — it was because execution was blocked. The −3% relative underperformance is a real cost of not being live. Every day in cash in a bull market is a missed opportunity.

**5. CJ's real book context matters for holistic sizing decisions.**
CJ's real portfolio (Fidelity) is ~99% tech, ~45% AMD. Even though the paper account is independent, avoided adding AMD to the paper book today to prevent a situation where a bad AMD week destroys both the real and paper portfolios simultaneously. Took NVDA instead (different semi company, different product cycle risk).
