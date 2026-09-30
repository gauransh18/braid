/**
 * The beat sheet as data. "Cat Walk" (Arulo, Mixkit) at 130 BPM, measured with scripts/beats.py
 * (grid spread 2.2 ms). The bass enters at 14.769 s in the song and the full lift lands 8 bars later.
 * The film starts 4 bars before the bass, so bar 5 = bass in ("Meet braid") and bar 13 = full lift (first merge).
 */
export const BPM = 130;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const BARS = 28;
export const DURATION = BARS * BAR;
export const SONG_OFFSET = 14.769 - 4 * BAR;

/** Seconds at bar (1-based), beat (1-based) and a fraction of a beat. */
export const b = (bar: number, beat = 1, fraction = 0) => ((bar - 1) * 4 + (beat - 1) + fraction) * BEAT;

export const ACT = {
  solo: [b(1), b(2)],
  punch1: [b(2), b(3)],
  fail: [b(3), b(4)],
  punch2: [b(4), b(5)],
  meet: [b(5), b(7)],
  world1: [b(7), b(12)],
  punch3: [b(12), b(13)],
  world2: [b(13), b(19)],
  punch4: [b(19), b(20)],
  branch: [b(20), b(22)],
  punch5: [b(22), b(23)],
  outro: [b(23), b(29)],
} as const;
