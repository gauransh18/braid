# braid video kit

The look, rules, assets and code for every braid film. Each film prompt points here and only adds its story.
Sources: `ui/index.html` (dashboard, tokens, sprites), `README.md`, `docs/DESIGN.md`, `src/demo.ts` (demo data), `src/cli.ts` (terminal copy), product owner interview (2026-09-30).
When this file and the repo disagree, the repo wins.

## The brief (from the interview)
- Plays: launch video with sound (README, GitHub release, X, Product Hunt). Master 16:9 1920x1080; 1:1 and 9:16 cutdowns later from the same timeline. Length 45 to 60 s.
- Music: "Cat Walk" by Arulo, Mixkit Stock Music Free License (https://mixkit.co/license/#musicFree). 130 BPM.
- Must show: goal to task graph (`braid plan`), the floor (agents in worktrees).
- Ingredients: Knot narrates (speech bubble) + braid rope as logo reveal · big punchlines between scenes · magic moves · dark theme.
- Ending: lockup, `npm link`, github.com/gauransh18/braid.

## Hard rules
- Casing: sentence case for UI text, lowercase chips and ids (`.chip { text-transform: lowercase }`, ui/index.html).
- Type: Pixelify Sans for the wordmark and panel titles (`.pixel`), JetBrains Mono for ids, costs, commands (`.mono`), system-ui for body (ui/index.html).
- Corners: panels 14 px, desks 12 px, buttons 8 px, chips 5 px, pills 999 px (ui/index.html).
- Surfaces: `--bg` page with the 12 px weave grid; `--panel` for panels, `--panel-2` for desks (ui/index.html).
- Borders: 1 px `--line` on panels, 2 px `--line` on desks, 2 px `--line-2` on Knot's bubble. Shadow `--shadow` on panels.
- Copy: no em or en dashes; plain words; the loom/strand/braid metaphor is the product's own voice (`knotSays()`).
- Claims: see "Claims".

## Frame (1920x1080, 60 fps, dark)
- Dashboard scenes are the real dashboard layout at 1.5 to 1.7x, full bleed on `--bg` with the weave.
- Punchlines: Pixelify Sans 600, 120 to 140 px, `--text`, key words `--accent` (or `--err` / `--ok` when the word is a status).

## Color (dark, ui/index.html :root dark)
| Token | Value | Use |
|---|---|---|
| bg | #12131c | background |
| bg-2 | #171926 | terminal body (default) |
| panel | #1d1f2d | panels, bubble |
| panel-2 | #232638 | desks |
| line / line-2 | #2c2f44 / #3a3e58 | borders, rope tail |
| text / muted / faint | #ecebf5 / #9a9cb3 / #666985 | |
| accent | #b48cff | Knot, key words |
| ok / warn / err / info | #3fcf8e / #f5b942 / #ff6b6b / #6cb6ff | status chips, soft bg: #173327 / #3a2f16 / #3b1d22 / #182a40 |
| weave | rgba(255,255,255,.025) | 2 px lines every 12 px |
| task colors | #ff7a90 #3cc8b4 #f5b942 #9b7bff #5aa9ff #8fd14f #ff9a4d | by plan order |

## Signature elements
| Element | Source | In films |
|---|---|---|
| Pixel blob agents (20x20 canvas, moods) | `drawBlob` ui/index.html | frame-driven twin: same code, `f = floor(t * 8)` (dashboard redraws at 8 fps) |
| Knot mascot (#b48cff, tuft pink/teal/yellow) | `KNOT` ui/index.html | same twin, narrates via bubble |
| Desk card with left color bar, chip, attempt dots, cost | `.desk` | twin (no hover/transition) |
| Threads between desks (3 px, dashed flow when live) | `drawThreads` | SVG, dash offset from `t` |
| The braid rope (3 sine strands, beads, dashed tail) | `renderBraid` | twin, grows per merge; becomes the logo |
| Stats (Merged, Spend meters) | header `.stat` | twin, numbers from `t` |

## Components
| Need | Source | In films |
|---|---|---|
| Blob / Knot | drawBlob | twin: pure painter, driven by t (original runs on setInterval) |
| Desk, chip, dots | `.desk`, `.chip`, `.dots` | redraw in React with same tokens (original is DOM strings) |
| Rope | renderBraid | redraw, strands grow with a spring |
| Bubble | `.bubble` | redraw |
| Terminal | none in product | minimal: `--bg-2` body, mono text, real CLI copy only |

## Motion
- The product has no springs; its UI moves at 8 fps sprite frames, `transform .15s`, `.25s ease`. Film defaults (marked default): springs 170/26 for panels, 150/20 for magic moves, 320/30 for chips. No glows, particles, bounce.

## Claims
- Does: plans a goal into a task graph; runs each task with an agent (Claude Code, Codex, Gemini) in its own git worktree; verify commands must pass, optional reviewer, verify again after merge; rolls back merges that break the combined tree; hard budget cap; never touches your branches (work lands on `braid/<runId>/integration`); dashboard; macOS app.
- Never show: agents pushing to main, "fully autonomous", guaranteed correct code, speed multipliers we have not measured.
- Approved lines (from repo): "A multi-agent coding harness for small teams." "Your branches are never touched." "All 7 strands braided."
- Demo numbers come from `braid demo` (mock driver). The run select reads "demo run" so they are never passed off as a real run.

## Workspace
- `videos/` own package, Remotion 4.0.530 pinned, React 19.1. Fonts in `public/fonts` (fontsource woff2). Music in `public/audio/launch/music/` (gitignored).
- Scripts: `scripts/beats.py`, `scripts/stills.ts`, `scripts/render.ts`, `scripts/verify.py`.
