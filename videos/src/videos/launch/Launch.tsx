import { useEffect, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, interpolate, staticFile, useVideoConfig } from "remotion";
import { fontsReady } from "../../fonts";
import { TargetLog } from "../../kit/debug";
import { Punchlines, type Card } from "../../kit/punchlines";
import { useTime } from "../../kit/time";
import { Branches, Meet, Outro, Solo } from "./acts";
import { BEAT, DURATION, SONG_OFFSET, b } from "./cues";
import { C, FONT } from "./tokens";
import { weave } from "./ui";
import { World } from "./World";

/** Punchlines: one idea each, the product's own words where it has them. */
const CARDS: Card[] = [
  { lines: [[{ text: "One agent.", at: b(2, 1) }, { text: "One task.", at: b(2, 2) }], [{ text: "At a time.", at: b(2, 3), accent: true }]], out: b(3) - 0.1, y: 540, size: 132 },
  { lines: [[{ text: "Agents say", at: b(4, 1) }, { text: "done.", at: b(4, 1, 0.5) }], [{ text: "Tests say", at: b(4, 3) }, { text: "no.", at: b(4, 3, 0.5), accent: true }]], out: b(5) - 0.1, y: 540, size: 132 },
  { lines: [[{ text: "Nothing merges", at: b(12, 1) }], [{ text: "until", at: b(12, 2) }, { text: "tests pass.", at: b(12, 2, 0.5), accent: true }]], out: b(13) - 0.1, y: 540, size: 132 },
  { lines: [[{ text: "Your branches", at: b(19, 1) }], [{ text: "stay", at: b(19, 2) }, { text: "untouched.", at: b(19, 2, 0.5), accent: true }]], out: b(20) - 0.1, y: 540, size: 132 },
  { lines: [[{ text: "Many agents.", at: b(22, 1) }], [{ text: "One clean", at: b(22, 2, 0.5) }, { text: "branch.", at: b(22, 3), accent: true }]], out: b(23) - 0.1, y: 540, size: 132 },
];
// status words take the status color, like the dashboard's chips
const ACCENTS = [C.accent, C.err, C.ok, C.accent, C.accent];

export function Launch({ debug }: { fps: number; debug?: boolean }) {
  const t = useTime();
  const { fps } = useVideoConfig();
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => { fontsReady.then(() => continueRender(handle)); }, [handle]);
  const knotLanded = t >= b(7) + 0.9;

  return (
    <AbsoluteFill style={{ ...weave(20, 3), overflow: "hidden", fontFamily: FONT.body }}>
      <Audio
        src={staticFile("audio/launch/music/m371.mp3")}
        trimBefore={Math.round(SONG_OFFSET * fps)}
        volume={(f) => interpolate(f / fps, [0, 0.05, DURATION - 2 * BEAT * 2, DURATION], [0, 0.9, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
      />
      <Solo t={t} />
      <World t={t} knotVisible={knotLanded} />
      <Meet t={t} />
      <Branches t={t} />
      <Outro t={t} />
      {CARDS.map((card, i) => (
        <Punchlines key={i} t={t} cards={[card]} theme={{ font: FONT.pixel, color: C.text, accent: ACCENTS[i], weight: 600 }} />
      ))}
      {debug ? <TargetLog /> : null}
    </AbsoluteFill>
  );
}
