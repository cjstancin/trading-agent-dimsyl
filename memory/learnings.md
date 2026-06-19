# Learnings — Bull (paper)
# One dated lesson per run. Honest, not cheerleading.

---

## 2026-06-19
**Lesson:** The cloud execution environment requires explicit egress allowlist configuration for external APIs. `paper-api.alpaca.markets` is blocked, which means Bull cannot fetch live account state or place orders from this environment. Research and journaling still work; execution does not. Fix: CJ adds Alpaca to the environment's network egress settings (see cloud docs). Until then, every run is research-only — which burns time and misses setups. This is a day-one infrastructure gap, not a trading mistake, but it's a gap that will compound if left open.

**Secondary lesson:** VIX at 16.41 is on the NEUTRAL/RISK-ON border. The strategy says < 16 = full aggression. Sitting at 16.41 means being more selective and trimming sizes 25% is the right call, even though the market feels risk-on (Nasdaq at record, Iran ceasefire). The rules exist for when it feels "too good to sit on the sidelines" — follow them.
