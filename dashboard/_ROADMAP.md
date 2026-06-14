# Bull (dashboard) — Living Roadmap & Todo

> Source of truth for the Bull paper-trading console (bull.dimsylaisolutions.com). Read first when picking up dashboard work; keep refreshed after every decision, idea, or shipped item. Architecture/data contract: `dashboard/ARCHITECTURE.md`.

## Vision
The **monitor** for an aggressive automated **Alpaca paper** trading agent — "what is the bot doing and is it within its risk limits." Health/uptime, every position/order/fill, a graded trade journal, and live risk meters. Decoupled from Go (the advisor/research hub). Static & cheap: one fetched `status.json`, no framework, no secrets in the page.

## Locked decisions
- **Theme: "Royal Chisel"** — alabaster marble background, `clip-path` 45°-cornered cards with a constant slow gold-gradient rim (`goldflow`, no white gleam), Cinzel (display) + Fraunces (numbers) + EB Garamond (body), emerald up / ruby down, faceted gemstone status dot. **Keep it** (single committed theme; the `goldflow` sheen is intentional and reduced-motion-guarded).
- **Paper-first, safety-first.** Bot trades Alpaca paper only; the LIVE profile is LOCKED behind CJ's written opt-in. The "control panel" is a **UI preview** — it never sends orders from the browser.
- **Vanilla MPA**, real `<a>` tab nav, version-stamped assets (`?v=…`), shared header/tabs, hover prefetch.

## Phases / status
- **P0 — Console pages** ✅ shipped (Overview, Positions, Blotter, Journal, Risk, Strategy, Movers + ticker detail).
- **P1 — Design hardening** ✅ shipped (2026-06-13): impeccable a11y/perf/contrast pass (see changelog).
- **P2 — Wire to the live agent** 🔜 the control panel + risk halts are currently preview; connect to the Bull Claude Code routine.

## Audit baseline (2026-06-13)
Pre-fix ~**13/20**. Gaps mirrored Go's: div/span controls not keyboard-operable, **no `:focus-visible` at all**, no `<h1>`, unmanaged embed modal, and three failing contrast tokens (`--dim`, `--emer`, `--amber` + `--goldd` on body). Theme was already single + committed (clean). All addressed; estimated ~19/20.

## Future-vision backlog (ranked easiest → hardest)
1. **Re-run an a11y/contrast audit** to confirm and catch regressions. *Easy.*
2. **Label the bot-state / regime pills with `aria-live`** so screen readers hear status changes on refresh. *Easy.*
3. **`<th>` sort: add `aria-sort`** (currently sortable via keyboard but state isn't announced). *Medium.*
4. **Decide the embed iframe `sandbox` policy** — keeps `allow-same-origin` for embed function (deliberate). *Medium.*
5. **Wire the control panel + risk halts to the live routine** (today they're a preview). *Hard.*

## Random-suggestion inbox
- _(empty — drop raw ideas here with full premise.)_

## Changelog
- **2026-06-13** — impeccable redo (mirrors Go's pass):
  - **a11y/keyboard** — div/span controls now focusable + Enter/Space-activatable via a `MutationObserver`-backed enhancer; table rows stay real rows (focusable, not `role=button`); added the missing `:focus-visible` ring; `role="dialog"` + focus-trap + restore on the embed overlay; link interceptor respects modifier/middle clicks.
  - **labels** — `aria-label`s on the risk-per-trade slider + read-only badge; decorative glyphs hidden from AT; visually-hidden per-page `<h1>`.
  - **contrast** — darkened `--dim`/`--emer`/`--amber`/`--goldd` to pass WCAG AA (4.5:1) on both card and body; chart line color matched to the new emerald + `role="img"` trend labels.
  - **perf/robustness** — 5-min refresh skips rebuild while the slider/modal is in use. The `goldflow` rim sheen was intentionally kept (documented signature, motion-guarded).
  - Added `?v=0613a` asset stamps (the pages had none).
