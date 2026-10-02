---
workflow: product-launch-video
flow: automation
storyboard: no
message: "braid runs a team of coding agents on one repo and merges only what passes your tests."
destination: github-readme-x-product-hunt
aspect: 1920x1080
language: en
length: 60s
angle: problem-first
narration: no
style_preset: none (design system comes from videos/BRAND.md)
---

## Intent

Second launch film for braid, made in HyperFrames (the first is the Remotion film in `videos/src/videos/launch`, left untouched). Plays with sound on the README, GitHub release, X and Product Hunt. Problem first, one core message early, the product shown in use, one objection answered (your branches are never touched), a clear CTA. Dark, pixel-flavoured, Knot the mascot as a narrator through speech bubbles and big punchlines; no voice-over.

## Assets

- ../BRAND.md — look, tokens, hard rules, approved claims. Source of truth for color, type, copy.
- ../out/braid-launch/poster.jpg and ../out/review/*.png — renders of the real dashboard from the first film; reference only.
- ../public/audio/launch/music/m371.mp3 — "Cat Walk" by Arulo, Mixkit free license, 130 BPM; cut a ~60 s segment on the bar grid.
- ../../ui/index.html — the real dashboard (tokens, drawBlob, KNOT sprites, renderBraid) to port frame-driven.
- ../../src/demo.ts, ../../src/cli.ts — demo data and real terminal copy.

## Customizations

- Must show: goal to task graph (`braid plan`) and the floor (agents in their own worktrees); merge gate (tests fail, goes back, passes); rope grows one strand per merge and becomes the logo.
- Ending: lockup, `npm link`, github.com/gauransh18/braid.

## Notes

- No capture: no live site. Repo + BRAND.md are the source. Capture path replaced by hand-built `capture/extracted/*`.
- No narration (signed out of HeyGen; local TTS deps missing). Music-only, on-screen text and Knot bubbles carry the story.
- Copy rules from BRAND.md: sentence case UI, lowercase chips/ids, no em or en dashes. Never show agents pushing to main, "fully autonomous", unmeasured speed claims. Demo numbers must read as a demo run.
- Run shape: autonomous (user said just generate it). Render stays user-gated.
