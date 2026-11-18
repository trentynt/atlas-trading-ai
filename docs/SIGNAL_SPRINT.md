# SIGNAL design sprint — progress record

Working brand **SIGNAL** (provisional, pending trademark clearance). Engineering codename **ATLAS**.
This file is updated as work lands so the sprint can resume if a session ends.

## Baseline (before redesign)
- Backend tests: 30 passed. Frontend build: OK. Nine workspaces render with no console errors or horizontal overflow at 1600×1000.
- Stack: React 19 + TypeScript + Vite 8 + Tailwind 4, lightweight-charts 5, custom canvas/SVG charts. Hash routing (`#command` … `#telemetry`).
- Verified instruments: EUR/USD, GBP/USD, USD/JPY (ECB daily reference fix — close only, not executable), BTC/USD, ETH/USD (Coinbase daily OHLCV, Kraken failover).

## Checklist
- [x] 1. Design system: tokens, type scale, motion, shared components (cards, buttons, segmented, tabs, tooltip, drawer, dialog, toast, states)
- [x] 2. Shell: SIGNAL brand, renamed navigation, global search (workspaces + instruments + actions), keyboard nav
- [x] 3. Overview (formerly Command) — flagship
- [x] 4. Computation sphere — calmer composition, factual-vs-decorative toggle, label collision avoidance, reduced motion
- [x] 5. Markets, Research, Strategies, Forecasts, Portfolio, Risk, Discoveries, Activity
- [x] 6. Verification: screenshots at 1600 / 1280 / 390 widths, overflow checks, tests + build
- [x] 7. Marketing package: screenshots, recordings, landing page + waitlist
- [x] 8. Final report

## Constraints kept
- No backend rewrites; API contracts unchanged (additive endpoints only).
- Paper-only; no broker code; no fabricated results, markets, or model claims (no Kronos).
- Higgsfield connector requires authorization — assets are produced locally for upload.

## Progress log
- Design system: tokens + type scale (`frontend/src/index.css`), components (`frontend/src/components/ui.tsx`), toasts, routing with deep links and aliases (`lib/route.ts`), plain-language copy (`lib/explain.ts`).
- All nine workspaces rebuilt: Overview, Markets, Research, Strategies, Forecasts, Discoveries, Portfolio, Risk, Activity. Route keys unchanged; aliases `#overview #strategies #forecasts #discoveries #activity` added.
- Sphere: factual arcs vs optional decorative strands, collision-free labels, inertia, play/pause/reset, reduced-motion, node inspector drawer with deep links.
- Verification: 9/9 views render at 1600, 1280, 390 with no console errors or horizontal overflow; 14/14 scripted interaction flows pass.
- Verification side effect: two simulated 5,000 EUR/USD paper orders were placed by the flow test.
- Fixed during verification: search race (data now preloaded), live refresh starvation during research cycles (debounce → throttle), −0.00% display, flat equity chart, mobile header/legend overflow.
- Marketing: 11 screenshots, 6 MP4 recordings (`marketing/`), landing page `frontend/landing.html` with working waitlist (`POST /api/waitlist`, test added → 31 backend tests).
- Verification side effects: four simulated EUR/USD paper orders (2×5,000, 2×1,000) and two real research cycles (cycles 3–4) were created while testing and filming. One QA waitlist sign-up was created and then deleted.

## Continuation plan
1. Autonomous research-to-paper phase (durable worker hardening, promotion gates, stricter OHLCV rejection, restart/idempotency tests) — not started; tracked separately from this visual sprint.
2. Code-split the app bundle (~520 kB) by workspace.
3. Commit the sprint on `feature/atlas-platform` (nothing committed yet — awaiting approval).

## Quality review (design standard)
- Standard written to `docs/DESIGN.md` (permanent).
- Removed: background/button/logo/landing glows, card glass blur, hover lifts, list stagger, always-on header badges, "Good evening" greeting, Overview "At a glance" grid, duplicate Research step/agent grids, initials avatars, landing proof-strip vanity metric, boxed-everything landing layout, "thinks"/"living" copy.
- Sphere now still by default; rotation and decorative strands are opt-in.
- Paper equity sparkline uses an honest minimum scale (a $2 move no longer looks like a crash).
- Re-verified: 14/14 flows, 9 workspaces at 1600/390 with no overflow or console errors, landing at 1440/390, 31 backend tests, build, lint. Marketing screenshots, landing images and all six recordings recaptured from the current UI.
- Side effects: two more real research cycles (5–6) and three simulated 1,000 EUR/USD paper orders from test runs; QA waitlist entries deleted.
