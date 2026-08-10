# DESIGN.md — Bill the Bull v2 console

## Theme

Dark operator console. Scene: CJ at his desk in a dark room, evenings, multi-monitor at 70–80%
zoom, checking the paper book between other fleet work — the ambient light and the task both force
dark. Restrained color strategy: tinted dark neutrals + one ember accent ≤10%; green/red reserved
for market semantics.

## Color (OKLCH)

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.16 0.01 260)` | body background (cool near-black) |
| `--surface` | `oklch(0.20 0.012 260)` | panels, tables |
| `--surface-2` | `oklch(0.24 0.014 260)` | header strip, hover rows, collapsible heads |
| `--line` | `oklch(0.32 0.015 260)` | hairline borders |
| `--ink` | `oklch(0.93 0.005 260)` | primary text |
| `--ink-mut` | `oklch(0.72 0.01 260)` | labels, secondary text (≥4.5:1 on bg/surface) |
| `--accent` | `oklch(0.74 0.15 55)` | ember — actions, selection, focus ring |
| `--up` | `oklch(0.76 0.14 155)` | market up / gains ONLY |
| `--down` | `oklch(0.68 0.19 25)` | market down / losses / halts ONLY |
| `--warn` | `oklch(0.8 0.13 85)` | cautions (dial caution, brake tier 1–2) |

## Typography

One family: `ui-sans-serif, system-ui, "Segoe UI", sans-serif`; data/numbers get
`font-variant-numeric: tabular-nums`. Fixed rem scale, ratio 1.125: 0.75 / 0.875 / 1 / 1.125 /
1.266 / 1.424. No display fonts anywhere.

## Layout

Full-bleed fluid app shell (no max-width caps — CJ's zoom lesson). Sticky header: identity + the
always-visible state strip (mode · dial · brake · halts · pending approvals count) + view tabs.
Views: **Book** (racing curves + gate meters) · **Trades** (explorer table + expandable story rows)
· **Signals** (watchlist, sleeve signal feeds, shadow books) · **Controls** (sleeve pause/resume,
kill-switch, mode, approvals queue). Collapsible `<details>` sections for secondary depth. Grid
`repeat(auto-fit, minmax(320px, 1fr))` for panel rows; tables scroll inside their panel.

## Components

Buttons: 1 shape (6px radius), accent for primary, outline for secondary, `--down`-tinted for
destructive (kill-switch) with confirm step. All controls have default/hover/focus/active/disabled.
Charts: inline SVG line charts, indexed racing curves (book vs SPY vs sleeves, base 100), gate
meters as horizontal bars. Empty states teach ("no marks yet — the book hasn't launched").
Motion: 150–200ms ease-out state transitions only; `prefers-reduced-motion` → none.
