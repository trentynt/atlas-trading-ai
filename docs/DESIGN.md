# SIGNAL design standard

This is a permanent standard. Every new screen, component, chart and sentence in SIGNAL is reviewed against it.

**We are not trying to look like an AI company. We are building an exceptional software company that happens to use AI.**
Our benchmark is the restraint and craftsmanship of the best consumer and professional software, not its look. SIGNAL develops its own identity.

## Principles

1. **Every element earns its place.** If it doesn't help someone understand, decide or act, remove it. Nothing exists to make a screen look busy or futuristic.
2. **No AI-dashboard clichés.** No glows, random gradients, glass for its own sake, rows of identical rounded cards, generic metric grids, ever-present status badges, or decorative animation.
3. **Craft over effects.** Typography, alignment, spacing, contrast, hierarchy and interaction quality matter more than any visual effect.
4. **Write like a thoughtful product team.** Precise, plain, confident language. No buzzwords, no hype, no anthropomorphising software ("thinks", "living", "intelligent").
5. **Never fabricate.** No invented functionality, results, findings, market coverage, activity or user numbers. Small real numbers beat large invented ones.
6. **The sphere serves the user.** It must stay meaningful, readable and interactive, and it is never more important than the user's actual task.
7. **Workflows over screens.** A beautiful screen that is hard to use is a failed design. Design the path between screens.
8. **Purpose over uniformity.** Workspaces share one system but are shaped by their job — a list where a list is right, a single sentence where a metric grid would be filler.
9. **Progressive disclosure.** The default view is understandable to a newcomer; depth (logs, raw values, parameters) is one click away, never removed.
10. **Design for trust.** Show uncertainty, limitations, risk and data provenance clearly. Never soften a warning for aesthetics.

## How the principles apply

### Visual system
- **Surfaces:** flat graphite (`--surface-1`), a single hairline border, a soft drop shadow for depth. No background gradients, no blur on cards. Blur is allowed only where content scrolls beneath it (header, overlays).
- **Colour carries meaning.** Mint (`cy`) = interaction and selection. Amber (`am`) = attention, paper-trading reminders, research caution. Red (`dn`) = genuine risk, losses, destructive actions. Green (`up`) = gains and passed checks. Violet (`vi`) = historical simulation. No colour is used decoratively.
- **Charts:** use the validated categorical palette (`SERIES` in `components/ui.tsx`) in fixed order. Scales must be honest — small moves must not be drawn as dramatic ones (see `Sparkline minRange`). Forecasts are always visibly distinct from observed data.
- **Type:** Inter with tabular figures for numbers; sentence-case labels; nothing smaller than 11 px; no all-caps micro-labels. JetBrains Mono only for IDs, versions and raw logs.

### Motion
- Motion must communicate **state, direction or progress**: workspace transitions, drawers opening, a job's progress bar, a pulse when a real backend event occurs.
- No entrance staggering, no hover lifts, no constant pulsing. `pulse-dot` is reserved for something that is actively running right now.
- The sphere is **still by default**. Rotation and decorative strands are opt-in controls. Reduced-motion settings disable non-essential motion everywhere.

### Status and badges
- Show status when it carries information. The header shows **exceptions and active modes only**: reconnecting, kill switch engaged, autonomous research on.
- A badge must change what the user understands (e.g. *Historical simulation*, *Paper trading · simulated*, *Accepted / Rejected*). Never add a badge that is always the same.

### Layout
- Prefer a sentence to a metric grid when the numbers are context, not the task (Discoveries summary, Overview summary).
- Use lists and tables for sequences and records (the research cycle, orders, risk events); use cards for things the user picks between or compares.
- Don't duplicate the same information in two panels on one screen.

### Copy
- Lead with what happened and what it means: *"Rejected — weak on unseen data, failed validation."*
- Name capabilities accurately. The research agents are **deterministic programs**; the optional LLM only narrates computed results and is labelled when used.
- Say what is not supported: daily data only; forex uses ECB reference rates (not executable quotes); paper trading only; backtests are historical simulations; forecasts are statistical baselines.
- Banned words and patterns: "revolutionary", "next-generation", "cutting-edge", "unleash", "supercharge", "AI-powered" as decoration, "living"/"thinking" applied to software, exclamation marks in UI copy.

### Trust checklist (every feature)
- [ ] Data source and freshness are visible or one click away.
- [ ] Simulated vs. real is unmistakable.
- [ ] Uncertainty and limitations are stated where a number could be over-read.
- [ ] Errors explain what happened and how to recover.
- [ ] Risk warnings are never hidden, shrunk or softened for aesthetics.

### Review checklist (before merging UI)
- [ ] Would anything be lost if this element were removed? If not, remove it.
- [ ] Is any effect (glow, gradient, blur, animation) purely decorative? Remove it.
- [ ] Does the copy sound like a person wrote it for this exact situation?
- [ ] Is every number real, correctly scaled and labelled?
- [ ] Does the screen work at 1600, 1280 and 390 px with no clipping or horizontal scroll?
- [ ] Has the rendered result actually been looked at (screenshot), not just compiled?

## Where things live
- Tokens and motion: `frontend/src/index.css`
- Components: `frontend/src/components/ui.tsx`
- Plain-language copy and terminology: `frontend/src/lib/explain.ts`
- Sprint history and verification record: `docs/SIGNAL_SPRINT.md`
