# PRODUCT.md — Bill the Bull v2 operator console

_Source: the locked Bull v2 design doc (vault, 2026-08-10) + CJ's recorded decisions. Not inferred._

## Register

**Product.** Design serves the tool. The console is an authenticated operator surface for one user
in a task; the bar is earned familiarity and trust, not spectacle.

## Users & purpose

- **Sole user: CJ**, the operator of a four-sleeve paper trading book (Momentum / Insider / Anchor /
  Wildcard on a $5k Alpaca paper account). Desktop-first at his multi-monitor setup (he runs
  displays at 70–80% zoom → layouts must FILL the viewport, full-bleed, fluid units, no
  max-width+center caps). Mobile-usable for spot checks, not mobile-optimized.
- **Primary jobs**: (1) read the book's health in seconds — equity vs SPY, sleeve race, gate
  progress, drawdown vs the 15% ceiling; (2) understand any trade's full story (thesis, gates,
  verdicts, counterfactuals); (3) act on the "needs your call" queue — 13F drift flags, thesis
  escalations, brake tier-3 plans; (4) pause/resume sleeves, kill-switch, mode.
- **Context**: evenings/desk, dark room, between other fleet work. Mood: calm operator control.

## Brand & personality

- Three words: **honest, dense, calm.** The console's job is truth-telling — every number traces to
  the internal FIFO ledger; refusals and halts are loud; nothing decorates.
- Bill's identity (🐂, plain-spoken voice) lives in Discord copy, not in UI chrome.

## Anti-references

- **White-Gold (the v1 dashboard theme) — explicitly retired by CJ.** No cream/parchment surfaces,
  no gold accents, no light-luxury styling.
- SaaS hero-metric dashboards; decorative glassmorphism; neon "trading terminal" cosplay.

## Strategic design principles

1. **Dark, restrained, one accent.** Ember accent for actions/selection only; green/red are
   RESERVED as market-semantic data colors and never used decoratively.
2. **Density is a feature.** Tables and sparingly-labeled data panels over cards. Collapsibles for
   secondary depth; nothing hidden that a halt or escalation depends on.
3. **State is loud.** Halts, brake tiers, dial position, pending approvals are always visible in
   the header strip regardless of active view.
4. **No fabricated numbers.** Missing series render as "no marks yet" — the UI inherits the
   ledger's honesty rules.
5. **Auth pattern**: localhost bind + header token (v1 control-server pattern), tailnet/Caddy
   basic-auth on the VPS in front. The page never embeds the token (URL-fragment handoff).

## Accessibility

Single expert user; still keep ≥4.5:1 body contrast, visible focus states, and reduced-motion
support (the console must be readable at 70–80% browser zoom — i.e., effectively larger type).
