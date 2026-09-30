import { Easing } from "remotion";
import { step } from "../../kit/spring";
import { clamp01 } from "../../kit/time";
import { project } from "../../kit/camera";
import { Blob } from "./Blob";
import { ACT, BEAT, b } from "./cues";
import { BRANCH, MERGES, RUN_ID, TASKS } from "./floor";
import { C, FONT, KNOT } from "./tokens";
import { Bubble, Chip, Desk, Rope, Stat } from "./ui";
import { HEADER, cam } from "./World";

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const appear = (t: number, at: number, len = 0.3) => ease(clamp01((t - at) / len));
const within = (t: number, [a, z]: readonly [number, number], pad = 0.2) => t >= a - 0.001 && t < z + pad;
const exitOf = (t: number, end: number) => clamp01((t - (end - 0.12)) / 0.12);

/* ---------- bars 1 and 3: the problem, one agent at a time ---------- */

export function Solo({ t }: { t: number }) {
  const one = within(t, ACT.solo, 0);
  const three = within(t, ACT.fail, 0);
  if (!one && !three) return null;
  const end = one ? ACT.solo[1] : ACT.fail[1];
  const out = exitOf(t, end);
  const start = one ? 0 : ACT.fail[0];
  const enter = one ? 1 : appear(t, start, 0.2);
  const task = TASKS[2];

  // bar 1: running, the queue sleeps, elapsed jumps each beat. bar 3: says done, then the tests say no.
  const said = three && t >= b(3, 1, 0.25);
  const ran = three && t >= b(3, 2);
  const failed = three && t >= b(3, 3);
  const status = failed ? "failed" : said ? "done" : "running";
  const hours = ["0h 12m", "1h 05m", "2h 31m", "3h 48m"][Math.min(3, Math.floor((t - start) / BEAT))];
  const state = { status: status as never, attempts: 1, failed: failed ? 1 : 0, cost: 0, tokens: 0 };
  const scale = 2.6;

  return (
    <div style={{ position: "absolute", inset: 0, opacity: (1 - out) * enter, filter: out ? `blur(${out * 10}px)` : undefined }}>
      <div style={{ position: "absolute", left: 960 - 60 * scale, top: 470, scale: String(scale), transformOrigin: "0 0" }}>
        <Desk t={t} title={task.title} id={task.id} color={task.color} state={{ ...state, cost: 0 } as never} style={{ left: -110, top: -40 }} />
        {one ? (
          <Stat label="Elapsed" value={hours} style={{ position: "absolute", left: 130, top: -38 }} />
        ) : (
          <div style={{ position: "absolute", left: -110, top: 50, width: 360, fontFamily: FONT.mono, fontSize: 12, lineHeight: 1.6 }}>
            {ran ? <div style={{ color: C.text, opacity: appear(t, b(3, 2), 0.12) }}><span style={{ color: C.faint }}>$ </span>npm test</div> : null}
            {failed ? <div style={{ color: C.err, opacity: appear(t, b(3, 3), 0.12) }}>3 failing</div> : null}
          </div>
        )}
      </div>
      {/* the queue: six more agents, asleep until this one finishes */}
      {one ? (
        <div style={{ position: "absolute", left: 960, top: 740, translate: "-50% 0", display: "flex", gap: 22, alignItems: "center" }}>
          {TASKS.filter((q) => q !== task).map((q, i) => (
            <div key={q.id} style={{ opacity: appear(t, 0.05 + i * 0.5 * BEAT, 0.2) }}>
              <Blob t={t} color={q.color} mood="sleep" size={96} phase={i * 3} />
            </div>
          ))}
          <div style={{ marginLeft: 12, fontFamily: FONT.body }}>
            <Chip status="pending" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- bars 5 and 6: Meet braid. Knot then flies into the dashboard header. ---------- */

const MEET_KNOT = { x: 560, y: 330, size: 280 };

export function knotHandoff(t: number) {
  // Knot travels from the Meet spot to the header spot (live camera) on a spring from bar 7.
  const u = step(t - b(7), { stiffness: 150, damping: 20 });
  const view = cam(t);
  const to = project(view, HEADER.knot.x, HEADER.knot.y);
  const size = HEADER.knot.size * view.zoom;
  return {
    x: MEET_KNOT.x + (to.x - MEET_KNOT.x) * u,
    y: MEET_KNOT.y + (to.y - MEET_KNOT.y) * u,
    size: MEET_KNOT.size + (size - MEET_KNOT.size) * u,
    landed: t >= b(7) + 0.9,
  };
}

export function Meet({ t }: { t: number }) {
  if (t < ACT.meet[0] || t >= b(7) + 0.9) return null;
  const k = knotHandoff(t);
  const pop = step(t - b(5), { stiffness: 180, damping: 14 });
  const mood = t < b(5, 3) ? "jump" : t < b(7) ? "happy" : "work";
  const word = "braid";
  const wordOut = clamp01((t - (b(6) - 0.1)) / 0.18);
  const bubbleIn = appear(t, b(6, 1, 0.25), 0.2);
  const bubbleOut = clamp01((t - b(7)) / 0.15);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: k.x, top: k.y, width: k.size, height: k.size, scale: String(t < b(7) ? 0.6 + 0.4 * pop : 1), transformOrigin: "50% 100%" }}>
        <Blob t={t} color={KNOT.color} tuft={KNOT.tuft} mood={mood} size={k.size} />
      </div>
      {wordOut < 1 ? (
        <div style={{ position: "absolute", left: 880, top: 400, fontFamily: FONT.pixel, fontWeight: 700, fontSize: 190, lineHeight: 1, color: C.text, opacity: 1 - wordOut, filter: wordOut ? `blur(${wordOut * 12}px)` : undefined, display: "flex" }}>
          {word.split("").map((ch, i) => {
            const u = ease(clamp01((t - (b(5) + i * 0.5 * BEAT)) / 0.3));
            return <span key={i} style={{ opacity: u, translate: `0 ${(1 - u) * 36}px`, filter: u < 1 ? `blur(${(1 - u) * 16}px)` : undefined }}>{ch}</span>;
          })}
        </div>
      ) : null}
      {wordOut < 1 ? (
        <div style={{ position: "absolute", left: 888, top: 620, fontFamily: FONT.body, fontSize: 38, color: C.muted, opacity: appear(t, b(5, 4), 0.3) * (1 - wordOut) }}>
          A multi-agent coding harness for small teams.
        </div>
      ) : null}
      {t >= b(6) && bubbleOut < 1 ? (
        <div style={{ position: "absolute", left: 880, top: 470, scale: "2.6", transformOrigin: "0 50%", opacity: bubbleIn * (1 - bubbleOut) }}>
          <Bubble t={t} text="Give me a goal." since={b(6, 1, 0.25)} cps={14} style={{ left: 0, top: 0, translate: "0 -50%", whiteSpace: "nowrap" }} />
        </div>
      ) : null}
    </div>
  );
}

/* ---------- bars 20 and 21: the proof that your branches stay yours ---------- */

const RUN_LINES: { at: number; text: string; color?: string; accent?: [string, string] }[] = [
  { at: b(20, 1), text: "$ braid run plans/notes.json --budget 10", color: C.text },
  { at: b(20, 2, 0.5), text: `run ${RUN_ID}: done  base=main`, color: C.muted },
  { at: b(20, 3), text: "  spend:  $2.32", color: C.muted },
  { at: b(20, 4), text: "Review:  git log --oneline main..", accent: [BRANCH, ""] },
  { at: b(20, 4, 0.5), text: "Merge:   git merge ", accent: [BRANCH, ""] },
];

export function Branches({ t }: { t: number }) {
  if (!within(t, ACT.branch, 0)) return null;
  const out = exitOf(t, ACT.branch[1]);
  const enter = appear(t, ACT.branch[0], 0.25);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: enter * (1 - out), filter: out ? `blur(${out * 10}px)` : undefined }}>
      <div style={{ position: "absolute", left: 200, top: 150, width: 1520, height: 400, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 22, boxShadow: C.shadow, padding: "36px 44px", boxSizing: "border-box", fontFamily: FONT.mono, fontSize: 30, lineHeight: 1.75, whiteSpace: "pre" }}>
        {RUN_LINES.map((line, i) => (t >= line.at ? (
          <div key={i} style={{ color: line.color ?? C.text, opacity: appear(t, line.at, 0.12) }}>
            {line.text}
            {line.accent ? <span style={{ color: C.accent }}>{line.accent[0]}</span> : null}
          </div>
        ) : null))}
      </div>
      <BranchGraph t={t} />
    </div>
  );
}

/** main keeps its commits; the integration branch grows one bead per verified merge. */
function BranchGraph({ t }: { t: number }) {
  const x0 = 260, y0 = 850, mainEnd = 1660, forkX = 520, lane = 690;
  const beads = MERGES.map((m, i) => ({ c: m.task.color, x: 700 + i * 130, at: b(21, 1) + i * 0.5 * BEAT }));
  const draw = ease(clamp01((t - b(21, 1)) / (4 * BEAT)));
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
      <line x1={x0} y1={y0} x2={mainEnd} y2={y0} stroke={C.line2} strokeWidth={6} strokeLinecap="round" opacity={appear(t, b(20, 3))} />
      {[x0 + 40, x0 + 150, forkX].map((x) => <circle key={x} cx={x} cy={y0} r={13} fill={C.bg} stroke={C.muted} strokeWidth={5} opacity={appear(t, b(20, 3))} />)}
      <text x={mainEnd + 28} y={y0 + 11} fill={C.muted} fontFamily={FONT.mono} fontSize={30} opacity={appear(t, b(20, 3))}>main</text>
      <path d={`M${forkX},${y0} C${forkX + 90},${y0} ${forkX + 60},${lane} ${forkX + 170},${lane} L${mainEnd},${lane}`} fill="none" stroke={C.accent} strokeWidth={6} strokeLinecap="round"
        pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - draw} />
      {beads.map((bead, i) => {
        const u = step(t - bead.at, { stiffness: 320, damping: 30 });
        return <rect key={i} x={bead.x - 16} y={lane - 16} width={32} height={32} rx={7} fill={bead.c} stroke={C.bg} strokeWidth={4} opacity={clamp01(u * 2)} transform={`translate(0 ${(1 - u) * 16})`} />;
      })}
      <text x={mainEnd + 28} y={lane + 11} fill={C.accent} fontFamily={FONT.mono} fontSize={30} opacity={appear(t, b(21, 3))}>integration</text>
    </svg>
  );
}

/* ---------- bars 23 to 28: the rope becomes the logo, then the call to action ---------- */

export function Outro({ t }: { t: number }) {
  if (t < ACT.outro[0]) return null;
  const rs = 1.75;
  const grow = MERGES.map((_, i) => ease(clamp01((t - (b(23) + i * 0.5 * BEAT)) / 0.35)));
  const knotDrop = step(t - b(24), { stiffness: 180, damping: 16 });
  const word = "braid";
  const fade = clamp01((t - (b(28, 3))) / (2 * BEAT));
  const ropeX = 560, ropeY = 250;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - fade }}>
      <div style={{ position: "absolute", left: ropeX, top: ropeY, scale: String(rs), transformOrigin: "0 0" }}>
        <Rope colors={MERGES.map((m) => m.task.color)} grow={grow} total={7} knotTop={false} showTail={false} />
      </div>
      <div style={{ position: "absolute", left: ropeX + 27 * rs - 80, top: ropeY - 150 + (1 - knotDrop) * -260, opacity: clamp01(knotDrop * 3) }}>
        <Blob t={t} color={KNOT.color} tuft={KNOT.tuft} mood={t < b(24, 3) ? "jump" : "happy"} size={160} />
      </div>
      <div style={{ position: "absolute", left: 800, top: 300, fontFamily: FONT.pixel, fontWeight: 700, fontSize: 200, lineHeight: 1, color: C.text, display: "flex" }}>
        {word.split("").map((ch, i) => {
          const u = ease(clamp01((t - (b(24) + i * 0.5 * BEAT)) / 0.3));
          return <span key={i} style={{ opacity: u, translate: `0 ${(1 - u) * 36}px`, filter: u < 1 ? `blur(${(1 - u) * 16}px)` : undefined }}>{ch}</span>;
        })}
      </div>
      <div style={{ position: "absolute", left: 808, top: 530, fontFamily: FONT.body, fontSize: 40, color: C.muted, opacity: appear(t, b(24, 3), 0.3) }}>
        A multi-agent coding harness for small teams.
      </div>
      <div style={{ position: "absolute", left: 808, top: 640, opacity: appear(t, b(25), 0.25), translate: `0 ${(1 - appear(t, b(25), 0.25)) * 20}px`,
        fontFamily: FONT.mono, fontSize: 32, color: C.text, background: C.bg2, border: `1px solid ${C.line2}`, borderRadius: 12, padding: "14px 24px" }}>
        <span style={{ color: C.faint }}>$ </span>npm install && npm run build && npm link
      </div>
      <div style={{ position: "absolute", left: 808, top: 770, fontFamily: FONT.mono, fontSize: 40, fontWeight: 600, color: C.accent, opacity: appear(t, b(26), 0.25), translate: `0 ${(1 - appear(t, b(26), 0.25)) * 20}px` }}>
        github.com/gauransh18/braid
      </div>
    </div>
  );
}
