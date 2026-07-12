# Phase 0 Results — LLM Picking Edge Test (Sonnet 4.6)

## Experiment design
- **Question:** does Claude Sonnet 4.6's ranking of 18 mega-cap tickers beat a mechanical 63-day-momentum top-5 over the next 21 trading days — and does any edge survive outside its training data?
- **Model cutoffs:** training data **Jan 2026**; reliable knowledge **Aug 2025** — so the IN window is memorization-contaminated by construction (Glasserman & Lin "profit mirage").
- **IN window:** decisions 2024-01-02 → 2025-06-30, every 5th trading day (n=75 usable).
- **OOS window (clean):** decisions 2026-02-02 → last date with a full 21-day horizon (n=18 usable).
- **Arms:** LLM5 (model's top 5, equal weight), LLMbot5 (bottom 5), MOM5 (top 5 by 63d return, ties alphabetical), UNIV (all 18 equal weight), SPY. Rank IC = Spearman(predicted score 18..1, realized 21d return).
- **Inputs:** price-derived stats only (momentum / 200DMA / 20d-high / ATR%) — the same numbers MOM5 sees. Skipped picks: 0 errored, 0 malformed, 0 outside the calendar/horizon, 0 with missing prices.

Generation meta (`out/meta.json`): `{"experiment": "Phase 0 \u2014 Sonnet 4.6 stock-picking vs mechanical momentum; IN window measures memorization (profit mirage), OOS measures real edge", "model_cutoffs": {"training": "2026-01", "reliable_knowledge": "2025-08"}, "universe": {"AAPL": "Tech", "MSFT": "Tech", "NVDA": "Tech", "GOOGL": "Tech", "META": "Tech", "AMZN": "ConsumerDisc", "HD": "ConsumerDisc", "JPM": "Financials", "V": "Fina`

## IN vs OOS (all decision dates, weekly — horizons overlap)
| Metric | IN (memorized) | OOS (clean) |
| --- | --- | --- |
| Decision dates (n) | 75 | 18 |
| n used for LLM5−MOM5 | 75 | 18 |
| LLM5 mean 21d fwd | +1.71% ± 0.76% | +1.98% ± 1.13% |
| LLM5 − UNIV | -0.12% ± 0.54% | +0.77% ± 1.30% |
| LLM5 − MOM5 | -0.06% ± 0.30% | +2.15% ± 0.83% |
| LLM5 − SPY | -0.02% ± 0.57% | +0.08% ± 1.29% |
| Spread (LLM5 − LLMbot5) | -0.25% ± 0.86% | +0.69% ± 1.74% |
| Mean rank IC | +0.024 ± 0.042 | -0.007 ± 0.082 |
| IC t-stat | +0.57 | -0.08 |
| Hit rate LLM5>UNIV | 49% | 61% |
| Hit rate LLM5>MOM5 | 36% | 67% |
| Hit rate LLM5>SPY | 48% | 61% |

_IC t-stat above is nominal — weekly decisions with a 21-day horizon overlap, inflating it ~2×; the non-overlapping table below is the honest read._

## Absolute arm returns (mean 21d forward return per decision date)
| Arm (mean 21d fwd) | IN | OOS |
| --- | --- | --- |
| SPY | +1.74% | +1.90% |
| Universe (equal-weight) | +1.83% | +1.21% |
| Momentum top-5 (MOM5) | +1.77% | -0.18% |
| LLM top-5 (LLM5) | +1.71% | +1.98% |
| LLM bottom-5 (LLMbot5) | +1.97% | +1.28% |

## Robustness: non-overlapping decision dates (~every 21 trading days)
| Metric | IN non-overlap | OOS non-overlap |
| --- | --- | --- |
| Decision dates (n) | 15 | 4 |
| n used for LLM5−MOM5 | 15 | 4 |
| LLM5 mean 21d fwd | +0.93% ± 1.59% | +6.60% ± 3.96% |
| LLM5 − UNIV | -1.29% ± 1.22% | +5.45% ± 2.46% |
| LLM5 − MOM5 | -0.75% ± 0.67% | +4.38% ± 2.46% |
| LLM5 − SPY | -1.28% ± 1.24% | +4.91% ± 2.38% |
| Spread (LLM5 − LLMbot5) | -1.63% ± 1.75% | +7.85% ± 3.51% |
| Mean rank IC | +0.003 ± 0.092 | +0.301 ± 0.139 |
| IC t-stat | +0.03 | +2.16 |
| Hit rate LLM5>UNIV | 33% | 100% |
| Hit rate LLM5>MOM5 | 33% | 75% |
| Hit rate LLM5>SPY | 33% | 100% |

## Memorization gap (IN mean − OOS mean, 10,000-resample circular block bootstrap, block=5, 90% CI)
| Metric | IN mean | OOS mean | Gap (IN−OOS) | 90% CI |
| --- | --- | --- | --- | --- |
| LLM5 − UNIV | -0.12% | +0.77% | -0.89% | [-3.30%, +1.79%] |
| LLM5 − MOM5 | -0.06% | +2.15% | -2.21% | [-3.23%, -1.18%] |
| Rank IC | +0.024 | -0.007 | +0.030 | [-0.120, +0.183] |
| Spread | -0.25% | +0.69% | -0.95% | [-4.10%, +2.33%] |

Memorization mirage NOT confirmed at 90% confidence — no gap CI excludes 0 (note the thin OOS sample limits power).

## Verdict
POSITIVE OOS edge (OOS mean(LLM5−MOM5) = +2.15%, 90% block-bootstrap CI [+1.32%, +2.94%], n=18) — keep LLM as picker, continue forward-paper to confirm.

## How to read the verdict
**OOS absolute 21d forward returns** — SPY +1.90%, equal-weight universe +1.21%, momentum top-5 -0.18%, **LLM top-5 +1.98%**, LLM bottom-5 +1.28%. The verdict metric LLM5−MOM5 = +2.15% decomposes into LLM5 vs the equal-weight universe (+0.77%) plus momentum's own gap to that universe (-1.38%). So **most of the edge over momentum is the momentum baseline underperforming** a simple equal-weight of the same 18 names — 63-day momentum was a losing factor this window (a reversal regime), not the LLM outperforming simple benchmarks. Against the simplest baselines the LLM beat SPY by +0.08% and beat the equal-weight universe by +0.77%. Full-ranking rank IC is ~0 OOS (-0.007) — **no broad ordering skill** across all 18 names; the top-5 result is a narrow slice that may not generalize. **Bottom line:** a narrow, regime-dependent signal — it does **not** by itself justify expanding LLM authority. Forward paper trading remains the gate.

## Caveats
- **Thin OOS window** (~5 months of clean data) — low power; the verdict is provisional until more forward months accrue.
- **Price-only context:** the live picker gets news + web access; this test isolates the ranking-from-statistics skill only.
- **Survivorship-tilted universe:** currently-listed mega caps — read relative arms, not absolute returns.
- **Overlapping weekly horizons** make per-date returns autocorrelated — the verdict and gap CIs use a circular block bootstrap (block=5) to respect this, and the non-overlapping rows are a further robustness check. The plain SE/t columns in the tables are nominal.
- **Back-adjusted price levels:** the Close shown for IN dates is today's dividend/split-adjusted level, not the price the model saw in training — IN memorization operates through dates and return patterns, so the measured mirage is, if anything, conservative.
- **Single model, single run** — no seed/temperature variance estimate; rerun before major authority changes.
