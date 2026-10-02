---
format: 1920x1080
duration: 59s
message: "braid runs a team of coding agents on one repo and merges only what passes your tests."
arc: "PAS with Demo Loop: one agent, tests say no -> meet braid -> plan -> floor -> gate -> rope -> your branches -> lockup -> CTA"
audience: "developers on a small team, GitHub README / X / Product Hunt viewers"
mode: autonomous
---

## Video direction

**World.** The braid dashboard, rebuilt in HTML at 1920x1080 and driven by time, not a screenshot. Dark only. Page `--bg` `#12131c` with the 12 px weave (2 px lines every 12 px, `rgba(255,255,255,.025)`), panels `#1d1f2d` (radius 14, 1 px `#2c2f44`), desks `#232638` (radius 12, 2 px `#2c2f44`, 8 px left bar in the task color), chips radius 5 lowercase, pills radius 999. Pixelify Sans 600/700 for the wordmark, panel titles and punchlines; JetBrains Mono for ids, costs, commands and terminal; system-ui for body. Accent `#b48cff` is Knot and the key word in a punchline; status words use ok `#3fcf8e`, warn `#f5b942`, err `#ff6b6b`, info `#6cb6ff`. Task colors by plan order: schema `#ff7a90`, auth `#3cc8b4`, errors `#f5b942`, routes `#9b7bff`, tests `#5aa9ff`, docs `#8fd14f`, sdk `#ff9a4d`.

**Sprites are real.** Blobs and Knot come from `assets/braid-sprites.js` (`window.BraidSprites.drawBlob(ctx, color, mood, f, tuft)` on a 24x24 canvas, `image-rendering: pixelated`, scaled by an integer factor). Drive `f = Math.floor(t * 8)` from the timeline time, never `setInterval`. Moods: `sleep`, `work`, `inspect`, `review`, `jump`, `happy`, `dead`, `tied`. Knot is `color #b48cff`, `tuft ["#ff7a90","#3cc8b4","#f5b942"]`.

**Canonical dashboard geometry (every dashboard frame uses exactly this, so cuts match).** Header y 0-96: Knot sprite 72 px at x 48, wordmark "braid" Pixelify 700 44 px at x 136, a "demo run" pill centered-right, stats "Merged 0/7" and "Spend $0.00" right-aligned with mono numbers. Left panel "The floor" x 48-1296, y 120-1032. Right panel "The braid" x 1320-1872, y 120-1032. Desks 330 x 150 inside the floor panel at columns x 96 / 516 / 936 and rows y 230 / 410 / 590: schema (col0,row0), auth (col0,row1), errors (col0,row2), routes (col1,row0), docs (col1,row1), tests (col2,row0), sdk (col2,row1). A desk shows the id in mono, the title in body, a lowercase status chip, attempt dots, and a mono cost. Threads are 3 px lines between desk edges (dashed flow when live). The braid is the real rope: three sine strands (amplitude 11 px, stroke 5, round caps), a bead per merge in the task color, a dashed `#3a3e58` tail for strands still to go.

**Pacing (no narration, music-driven).** 130 BPM, bar = 1.846 s, beat = 0.4615 s. The whole film is 32 bars = 59.08 s. Every frame boundary sits on a bar line and each Scene cue below sits on a beat. Punchlines land ON the beat with a hard swap, not a fade. Reveals are cued to beats, never front-loaded: at t=0 only what the first beat names is on screen.

**Motion grammar.** Springs only for the pops and magic moves: panels 170/26, magic moves 150/20, chips 320/30 (translate to GSAP `power3.out` / `back.out(1.2)` equivalents that are seek-safe). The product has no glows, no particles, no bounce beyond the sprite's own bob; none here either. Sprite frames tick at 8 fps (a stepped function of `t`). Idle budget: at most the sprite bob, dash-offset flow on live threads, and mono numbers ticking; everything else holds still. Prefer stillness to bad motion.

**Rhythm / held frames.** Frames 1-2 are tight and percussive. Frame 3 is the release (the lift). Frames 4-7 are the demo run, steady. Frame 8 is a deliberate breather (calm, two panels, nothing moves except one bead). Frame 9 builds to the climax. Frame 10 ends on a long held read, then the music fades.

**Copy rules.** Sentence case for UI text, lowercase chips and ids. No em or en dashes anywhere. Plain words. Claims limited to: "A team of coding agents for your repo." "Your branches are never touched." "All 7 strands braided." "Many agents. One clean branch." "Nothing merges until tests pass." Demo numbers are shown under a "demo run" label. Never show an agent pushing to main, "fully autonomous", or a speed multiplier.

**Negative list.** No stock gradients, glassmorphism, glows, particles, lens flare, emoji, drop shadows beyond the panel shadow (`0 1px 0 rgba(0,0,0,.3), 0 10px 24px -12px rgba(0,0,0,.6)`). No slideshow (everything dumped in the first 25 percent then frozen) and no screensaver (many things drifting at once). No text lifted from `frame.md`. No captions, no voice-over, no `<audio>` in frames (the orchestrator mounts the Cat Walk bed).

**Canvas use.** Captions are disabled, so the full height is usable, but keep content inside 5.5 percent side padding (about 106 px) for punchline frames. Dashboard frames are full bleed.

## Frame 1 — One agent

- scene: One blob working, six asleep in a queue, a timer jumping each beat. "One agent. One task. At a time."
- duration: 3.692s
- poster: 3.0s
- transition_in: cut
- status: animated
- src: compositions/frames/01-one-agent.html
- blueprint: kinetic-type-beats
- asset_candidates: assets/braid-sprites.js — real blob painter (work and sleep moods) [focal]; assets/pixelify-sans-latin-700-normal.woff2 — punchline font; assets/jetbrains-mono-latin-400-normal.woff2 — timer font
- focal: the working blob
- roles: braid-sprites.js = the seven queue agents; pixelify = punchline; jetbrains = timer
- persuasion: Pain agitation through the queue of idle workers
- beat: tension
- handoff_out: none (hard cut to frame 2 on the bar line)

Problem first. Seven blob sprites in a row at y 380 (each 24 px canvas at 7x = 168 px, 24 px gaps, centered), colored in plan order. Weave bg, no chrome.

Scene 1 (0.0-0.46): Only the first blob (schema, mood `work`) is on screen, popped in on the downbeat at row start. The other six slots are empty outlines.
Scene 2 (0.46-0.92): The six others pop in left to right in a fast stagger, all `sleep`, with their Zzz. A mono timer "elapsed 0:00" appears under the first blob.
Scene 3 (0.92-1.85): Punchline "One agent." swaps in at y 650 (Pixelify 700, about 130 px, `--text`, "agent" in accent). Timer ticks "0:07" on the beat.
Scene 4 (1.85-2.77): Punchline hard-swaps to "One task." ("task" accent). Timer "0:19".
Scene 5 (2.77-3.69): Punchline hard-swaps to "At a time." ("time" accent). Timer "0:42". Hold the last 0.4 s still; the waiting blobs keep their Zzz.

## Frame 2 — Tests say no

- scene: Agent says done, `npm test` prints 3 failing, the blob flattens. "Agents say done. Tests say no."
- duration: 3.692s
- poster: 3.1s
- transition_in: cut
- status: animated
- src: compositions/frames/02-tests-say-no.html
- blueprint: compose
- asset_candidates: assets/braid-sprites.js — blob painter (work then dead mood) [focal]; assets/jetbrains-mono-latin-400-normal.woff2 — terminal text; assets/pixelify-sans-latin-700-normal.woff2 — punchline
- focal: the terminal output with red failing lines
- roles: braid-sprites.js = the single agent blob; jetbrains = terminal; pixelify = punchline
- persuasion: Negative contrast (done vs failing)
- beat: frustration
- handoff_out: none

A terminal panel (`--bg-2` `#171926`, radius 14, 1 px line) at x 360-1560, y 150-690 centered, blob 144 px (6x) to its left outside the panel at x 150, y 420.

Scene 1 (0.0-0.92): Blob (task color of schema) in mood `happy` bounces at the left. In the terminal, line 1 types fast: "agent: done. all green." (faint/ok). Punchline "Agents say done." swaps in at y 800 (Pixelify 700, 110 px, "done" in ok green).
Scene 2 (0.92-1.85): `$ npm test` types on the next line in mono; the cursor blinks once.
Scene 3 (1.85-2.77): Result lines print one per beat, in err red: "FAIL test/auth.test.js", "FAIL test/notes.test.js", "FAIL test/routes.test.js"; then "3 failing" in bold err. The blob swaps to mood `dead` on the "3 failing" line.
Scene 4 (2.77-3.69): Punchline hard-swaps to "Tests say no." ("no" in err red). Hold still.

## Frame 3 — Meet braid

- scene: Knot pops, the wordmark lands letter by letter, tagline, Knot says "Give me a goal."
- duration: 3.692s
- poster: 3.0s
- transition_in: cut
- status: animated
- src: compositions/frames/03-meet-braid.html
- blueprint: logo-assemble-lockup
- asset_candidates: assets/braid-sprites.js — Knot mascot painter, mood `happy` then `work` [focal]; assets/pixelify-sans-latin-700-normal.woff2 — wordmark; assets/jetbrains-mono-latin-400-normal.woff2 — tagline chip
- focal: the braid wordmark with Knot
- roles: braid-sprites.js = Knot; pixelify = wordmark; jetbrains = small mono kicker
- persuasion: Relief after pain; claim lands inside the first 10 s of the film
- beat: relief
- handoff_out: Knot sprite at x 960 y 300 scale 10x (240 px), full opacity, bubble top-right of Knot. Frame 4 begins with the dashboard where Knot sits in the header at x 48 y 12 scale 3x.

The lift: bass comes in on the downbeat of this frame. Center stage, weave bg.

Scene 1 (0.0-0.46): Cold black-purple screen, then Knot pops from scale 0 to 10x on the downbeat at (960, 300) with a spring (150/20), mood `happy`.
Scene 2 (0.46-1.85): "braid" lands one letter per half beat in Pixelify 700 at about 220 px, center x 960, y 560, white `--text` with the "a" in accent; letters rise from 24 px below with a hard opacity step, no blur.
Scene 3 (1.85-2.77): The tagline "A team of coding agents for your repo." fades up under the wordmark (system-ui 44 px, `--muted`).
Scene 4 (2.77-3.69): Knot's speech bubble (`--panel`, 2 px `--line-2`, radius 14) pops to the right of Knot: "Give me a goal." (system-ui 40 px, `--text`). Knot swaps to mood `work`. Hold.

## Frame 4 — Plan

- scene: `braid plan` types a goal, the plan prints, the terminal becomes the floor and seven desks land in waves with threads between them
- duration: 5.538s
- poster: 5.0s
- transition_in: cut
- status: animated
- src: compositions/frames/04-plan.html
- blueprint: prompt-type-submit-generate
- asset_candidates: assets/braid-sprites.js — Knot and the seven blobs (mood `sleep`) [focal]; assets/pixelify-sans-latin-600-normal.woff2 — panel titles; assets/jetbrains-mono-latin-400-normal.woff2 — terminal and ids
- focal: the task graph of seven desks with threads
- roles: braid-sprites.js = Knot in header and blob on each desk; pixelify = wordmark and panel titles; jetbrains = command and ids
- persuasion: Show-don't-tell (goal to graph)
- beat: curiosity then clarity
- handoff_in: Knot in the header at x 48 y 12, 72 px (3x), opacity 1, no motion at the cut, mood `work`
- handoff_out: all seven desks at the canonical geometry (cols x 96/516/936, rows y 230/410/590), status chip "pending", mood `sleep`, opacity 1, threads fully drawn, panels at canonical positions. Frame 5 starts from exactly this state.

Scene 1 (0.0-1.85, bar 7): The dashboard header is already there (wordmark, "demo run" pill, Merged 0/7, Spend $0.00) over the weave; the floor and braid panels slide in from their edges (panel spring 170/26). A terminal sheet (`--bg-2`) covers the floor panel area. The command types in mono: `braid plan "Add a notes API with auth, validation, tests and docs" --verify "npm test"`.
Scene 2 (1.85-3.69, bar 8): The planner prints one line per beat in mono: "planning with claude...", "7 tasks, 3 waves", "plan written to plans/notes.json". Knot, mood `inspect`, looks at it. Knot's tiny bubble: "Weaving a plan..." appears.
Scene 3 (3.69-5.54, bar 9): The terminal sheet collapses into the floor panel title "The floor". Desks land by wave on successive beats: wave 1 (schema, auth, errors) at 3.69, wave 2 (routes, docs) at 4.15, wave 3 (tests, sdk) at 4.6, each desk with a pending chip and a sleeping blob; threads draw from each dependency to its dependent (routes from the first three; docs from schema; tests and sdk from routes). The "The braid" panel shows "Nothing merged yet." Hold on the full graph.

## Frame 5 — The floor

- scene: The run starts. Agents wake in their own worktrees, threads flow, spend ticks. Punchline: "Each agent. Its own worktree."
- duration: 7.385s
- poster: 6.5s
- transition_in: cut
- status: animated
- src: compositions/frames/05-floor.html
- blueprint: camera-journey
- asset_candidates: assets/braid-sprites.js — blobs with live moods and Knot [focal]; assets/pixelify-sans-latin-700-normal.woff2 — punchline; assets/jetbrains-mono-latin-400-normal.woff2 — ids, costs, worktree paths
- focal: the wave of desks running in parallel
- roles: braid-sprites.js = blob on each desk; pixelify = punchline overlay; jetbrains = ids and costs
- persuasion: Feature to benefit (parallel, isolated)
- beat: confidence and control
- handoff_in: dashboard exactly as frame 4's handoff_out (desks pending, mood `sleep`)
- handoff_out: dashboard with schema, auth and errors in `verifying` (blob mood `inspect`, chip "verifying"), routes/docs/tests/sdk still `pending`; Merged 0/7; Spend $0.40; Knot bubble "Weaving 3 strands. 0 braided, 4 waiting."

Scene 1 (0.0-1.85, bar 10): Hold the graph one beat, then on the next beat the first wave wakes: schema, auth, errors flip to chip "running", blobs go to `work`, their threads switch to dashed flow (offset driven by `t`). Spend starts ticking from $0.00 in mono. Knot's bubble: "Weaving 3 strands. 0 braided, 4 waiting."
Scene 2 (1.85-3.69, bar 11): A small mono label slides in beside each running desk showing its worktree path: ".braid/worktrees/schema", ".braid/worktrees/auth", ".braid/worktrees/errors". Each label is the task's color. Camera pushes slowly (about 6 percent) toward the left column so the three isolated worktrees read.
Scene 3 (3.69-5.54, bar 12): Punchline overlay (Pixelify 700, 130 px) over a dimmed (0.35) dashboard, centered: "Each agent." then on the next beat "Its own worktree." ("worktree" in accent). Hard swaps on the beats.
Scene 4 (5.54-7.38, bar 13): Overlay clears; the camera returns to 1:1. Cost numbers keep ticking; the three running desks move to `verifying` on successive beats (blobs `inspect`). Spend reads $0.40. Hold.

## Frame 6 — The gate

- scene: schema passes and merges; auth fails `node check.js` and goes back with the output. "Nothing merges until tests pass."
- duration: 5.538s
- poster: 4.6s
- transition_in: cut
- status: animated
- src: compositions/frames/06-gate.html
- blueprint: compose
- asset_candidates: assets/braid-sprites.js — blobs (inspect, jump, happy, dead moods) and Knot [focal]; assets/pixelify-sans-latin-700-normal.woff2 — punchline; assets/jetbrains-mono-latin-400-normal.woff2 — verify lines
- focal: the auth desk failing then coming back
- roles: braid-sprites.js = blob on each desk; pixelify = punchline; jetbrains = verify output
- persuasion: Risk reversal (the gate protects the branch)
- beat: control with a flash of tension
- handoff_in: dashboard as frame 5's handoff_out
- handoff_out: schema `done` (chip "done", blob `happy`), errors `done`, auth in `running` attempt 2 with one red attempt dot, Merged 2/7, rope has two beads, Spend $1.10

Scene 1 (0.0-0.92): Punchline strip across the top of the floor panel (Pixelify 700, 96 px): "Nothing merges until tests pass." hard-sets on the downbeat, "tests pass" in ok green, then shrinks to a 44 px caption in the next Scene so the desks stay readable.
Scene 2 (0.92-1.85): schema's verify line prints in a mono strip under its desk: "schema verify (.) `npm test` -> pass" in ok. Blob swaps to `jump` and the thread to the braid panel lights; a bead in `#ff7a90` lands on the rope in "The braid". Merged ticks to 1/7.
Scene 3 (1.85-2.77): auth's verify line: "auth verify (.) `node check.js` -> fail (1)" in err red. Auth's blob goes `dead`, chip "failed", first attempt dot turns err. Knot's bubble: "auth failed `node check.js`. Sending it back with the output."
Scene 4 (2.77-3.69): auth snaps back to `running` attempt 2 (blob `work`, second dot active, chip "running"). Errors passes and merges (bead `#f5b942` joins the rope). Merged 2/7.
Scene 5 (3.69-5.54): Hold on the calm state: rope with two beads, auth retrying. Nothing new enters; the idle budget only (blob bob, flowing threads, ticking spend).

## Frame 7 — All braided

- scene: The rest of the strands merge one by one, the rope gains a bead each time, 7 / 7, Knot happy.
- duration: 5.538s
- poster: 5.0s
- transition_in: cut
- status: animated
- src: compositions/frames/07-rope.html
- blueprint: dataviz-countup
- asset_candidates: assets/braid-sprites.js — blobs and Knot (happy mood) [focal]; assets/pixelify-sans-latin-700-normal.woff2 — punchline; assets/jetbrains-mono-latin-400-normal.woff2 — numbers
- focal: the rope growing with a bead per merge
- roles: braid-sprites.js = blob per desk and Knot; pixelify = Merged counter and punchline; jetbrains = costs
- persuasion: Show-don't-tell proof (the run completes)
- beat: triumph
- handoff_in: dashboard as frame 6's handoff_out (Merged 2/7, rope two beads)
- handoff_out: all seven desks `done` (chip "done", blobs `happy`), Merged 7/7, Spend $2.32, rope with seven beads and no dashed tail, Knot `happy` with bubble "All 7 strands braided."

Scene 1 (0.0-1.85, bar 17): auth (retry passed) merges on the downbeat, then docs on the next beat, then routes: each time a bead in the task color lands on the rope with a small hop and the Merged counter ticks 3/7, 4/7, 5/7. The desk chips go `done`.
Scene 2 (1.85-3.69, bar 18): tests and sdk run (chips `running`), then merge on successive beats: Merged 6/7, 7/7. The dashed tail disappears as the last bead lands. Spend counts up in mono to $2.32.
Scene 3 (3.69-5.54, bar 19): Knot swaps to `happy`; bubble: "All 7 strands braided." The Merged stat pops once in accent. Hold. The rope panel is the hero: camera pushes about 8 percent toward it over the scene.

## Frame 8 — Your branches

- scene: A calm terminal and the git log: main untouched, the integration branch carries seven beads. "Your branches are never touched."
- duration: 5.538s
- poster: 4.8s
- transition_in: cut
- status: animated
- src: compositions/frames/08-branches.html
- blueprint: compose
- asset_candidates: assets/pixelify-sans-latin-700-normal.woff2 — punchline; assets/jetbrains-mono-latin-400-normal.woff2 — terminal; assets/braid-sprites.js — Knot (inspect mood) small in a corner
- focal: the two branches side by side, main flat, integration with seven commits
- roles: pixelify = punchline; jetbrains = terminal and branch names; braid-sprites.js = Knot watching
- persuasion: Risk reversal (the objection answered)
- beat: peace of mind
- handoff_out: none (cut)

The breather. Two columns on weave bg. Left: a branch lane labeled `main` (mono, `--muted`), a flat line with one bead (the last commit, `--faint`), a small "untouched" chip. Right: a lane labeled `braid/20260930-133204-urvg/integration` (mono, trimmed with ellipsis to fit) with seven beads in the task colors. Terminal strip across the bottom third (`--bg-2`).

Scene 1 (0.0-0.92): Punchline "Your branches" hard-sets at the top (Pixelify 700, 120 px).
Scene 2 (0.92-1.85): Punchline completes "are never touched." ("never" in accent). The two lanes draw in: main flat, integration empty.
Scene 3 (1.85-3.69): Seven beads land one per half beat on the integration lane (task colors); main does not change. 
Scene 4 (3.69-5.54): The terminal types the real end-of-run lines: "Review:  git log --oneline main..braid/20260930-133204-urvg/integration" then "Merge:   git merge braid/20260930-133204-urvg/integration". Hold still. Knot (24 px canvas at 4x) sits bottom-right, mood `inspect`.

## Frame 9 — Lockup

- scene: The rope draws itself, Knot drops on top, the wordmark and tagline. "Many agents. One clean branch."
- duration: 7.385s
- poster: 6.5s
- transition_in: cut
- status: animated
- src: compositions/frames/09-lockup.html
- blueprint: logo-assemble-lockup
- asset_candidates: assets/braid-sprites.js — Knot painter [focal]; assets/pixelify-sans-latin-700-normal.woff2 — wordmark and punchline; assets/jetbrains-mono-latin-400-normal.woff2 — chip
- focal: the rope turning into the logo
- roles: braid-sprites.js = Knot dropping onto the rope; pixelify = wordmark and punchline
- persuasion: Authority by repetition (the brand and the one-line promise)
- beat: inevitability
- handoff_out: lockup centered: rope vertical at x 960 from y 150 to y 520, Knot on top at (960, 120), wordmark "braid" center y 640, tagline y 760. Frame 10 begins with the wordmark and rope in the same place, scaled down.

Scene 1 (0.0-1.85): Screen cleared to weave bg. Three strands draw themselves top to bottom as sine curves in task colors (one pass per beat, stroke-dashoffset), forming the rope.
Scene 2 (1.85-3.69): Knot drops onto the top of the rope with a spring (150/20), mood `jump` then `happy`.
Scene 3 (3.69-5.54): Wordmark "braid" (Pixelify 700, 200 px) letters in, then the tagline "A team of coding agents for your repo." (system-ui, `--muted`).
Scene 4 (5.54-7.38): Punchline "Many agents. One clean branch." replaces the tagline line (Pixelify 700, 84 px, "one clean branch" in accent). Hold.

## Frame 10 — Get braid

- scene: The install line and the repo address, a long calm hold while the music fades.
- duration: 11.077s
- poster: 9.0s
- transition_in: cut
- status: animated
- src: compositions/frames/10-cta.html
- blueprint: typewriter-reveal
- asset_candidates: assets/braid-sprites.js — Knot and the small rope for the mark [focal]; assets/pixelify-sans-latin-700-normal.woff2 — wordmark; assets/jetbrains-mono-latin-400-normal.woff2 — commands
- focal: the install command and the repo address
- roles: braid-sprites.js = Knot at the end; pixelify = wordmark; jetbrains = commands
- persuasion: Friction reduction (three commands, no signup)
- beat: motivation
- handoff_in: wordmark "braid" and rope at the lockup position from frame 9, scaling down to a lockup at top-left (x 106, y 90, wordmark 96 px, rope 140 px tall) over the first beat

Scene 1 (0.0-1.85): The lockup shrinks to the top-left and a terminal (`--bg-2`, radius 14) opens to the right, x 520-1812, y 150-520.
Scene 2 (1.85-5.54): The single command types in mono: `npm install && npm run build && npm link` (finished by about 4.6 s); the cursor then holds and blinks on the beat. No other lines.
Scene 3 (5.54-7.38): The repo address lands big beneath, centered at y 700: "github.com/gauransh18/braid" (Pixelify 700, 84 px, "gauransh18/braid" in accent).
Scene 4 (7.38-11.08): Knot sits happy next to the address (mood `happy`, 6x), the strands sway at 8 fps. Everything holds; the last 2.5 s the music fades to silence under the held frame. No exit animation.
