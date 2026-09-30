import { Easing } from "remotion";
import { camera, worldTransform, type CameraKey } from "../../kit/camera";
import { step } from "../../kit/spring";
import { clamp01 } from "../../kit/time";
import { Blob } from "./Blob";
import { ACT, b } from "./cues";
import { BRANCH, BUDGET, GOAL, KNOT_LINES, MERGES, TASKS, fmtTok, fmtUsd, runState } from "./floor";
import { C, FONT, KNOT } from "./tokens";
import { Bubble, Desk, L, Pill, Rope, Stat, panelStyle } from "./ui";

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const inOut = Easing.bezier(0.65, 0, 0.35, 1);
const appear = (t: number, at: number, len = 0.3) => ease(clamp01((t - at) / len));

/** World point at the frame's center, and zoom. Heavy springs; the drop gets a small push. */
export const CAMERA: CameraKey[] = [
  [0, 410, 140, 2.1],
  [b(8, 3), 568, 290, 1.69],
  [b(13), 568, 292, 1.76],
  [b(14), 568, 290, 1.69],
  [b(17, 4), 590, 285, 1.74],
];
export const cam = (t: number) => camera(t, CAMERA);

/** Header spots, in world units, where Knot and the wordmark land (Meet hands them over). */
export const HEADER = { knot: { x: 12, y: 2, size: 60 }, word: { x: 70, y: 14, size: 26 } };

const PLAN_CMD = `braid plan "${GOAL}" --out plans/notes.json`;
const WROTE = "wrote plans/notes.json (7 tasks, planner spend $0.12). Edit it, then: braid run plans/notes.json";
const TYPE_FROM = b(7, 1, 0.5);
const TYPE_TO = b(7, 4, 0.75);
const MORPH = b(8, 3);

/** When each desk lands: waves from left to right, one per eighth note. */
const deskAt = (col: number, row: number) => b(9, 1) + (col * 2 + row) * 0.5 * (60 / 130);

export function World({ t, knotVisible }: { t: number; knotVisible: boolean }) {
  const inWorld = (t >= ACT.world1[0] && t < ACT.world1[1]) || (t >= ACT.world2[0] && t < ACT.world2[1] + 0.2);
  if (!inWorld) return null;
  const leave = clamp01((t - (ACT.world2[1] - 0.12)) / 0.12);
  const view = cam(t);
  const run = runState(t);
  const bubble = [...KNOT_LINES].reverse().find(([at]) => t >= at);

  // plan act: terminal types, prints, then morphs into the floor panel
  const typed = PLAN_CMD.slice(0, Math.max(0, Math.round(((t - TYPE_FROM) / (TYPE_TO - TYPE_FROM)) * PLAN_CMD.length)));
  const morph = step(t - MORPH, { stiffness: 150, damping: 20 });
  const termText = 1 - clamp01((t - MORPH) / 0.15);
  const termH = 150 + (L.floor.h - 150) * morph;
  const panelTitles = appear(t, MORPH + 0.35);
  const goalFly = inOut(clamp01((t - MORPH) / 0.55));
  const side = step(t - b(10), { stiffness: 170, damping: 26 });
  const stats = appear(t, b(10, 1, 0.5));

  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - leave, filter: leave ? `blur(${leave * 10}px)` : undefined }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: L.W, height: 560, transformOrigin: "0 0", transform: worldTransform(view) }}>
        {/* header */}
        <div style={{ position: "absolute", left: HEADER.knot.x, top: HEADER.knot.y, width: 60, height: 60, opacity: knotVisible ? 1 : 0 }}>
          <Blob t={t} color={KNOT.color} tuft={KNOT.tuft} mood={t >= b(17, 4) ? "happy" : run.active ? "work" : "idle"} size={60} />
        </div>
        <div style={{ position: "absolute", left: HEADER.word.x, top: HEADER.word.y, fontFamily: FONT.pixel, fontWeight: 700, fontSize: 26, lineHeight: 1, color: C.text, opacity: appear(t, b(7) + 0.35, 0.3) }}>
          braid
          <small style={{ display: "block", fontSize: 12, fontWeight: 400, color: C.muted, marginTop: 3 }}>watch</small>
        </div>
        {bubble && t > b(7) + 0.45 ? (
          <Bubble t={t} text={bubble[1]} since={bubble[0]} style={{ left: 160, top: 32, translate: "0 -50%", opacity: appear(t, b(7) + 0.45, 0.25) }} maxWidth={420} />
        ) : null}
        <div style={{ position: "absolute", right: 16, top: 12, display: "flex", alignItems: "center", gap: 14, opacity: stats, left: undefined }}>
          <Pill square={false}>demo run</Pill>
          {run.merged.length === 7 ? <Pill fg={C.ok} bg={C.okSoft} border="transparent">done</Pill> : <Pill fg={C.info} bg={C.infoSoft} border="transparent">running</Pill>}
          <Stat label="Merged" value={`${run.merged.length} / 7`} meter={run.merged.length / 7} meterColor={C.ok} />
          <Stat label="Spend" value={`${fmtUsd(run.spend)} / $${BUDGET}`} sub={`${fmtTok(run.tokens)} tok`} meter={run.spend / BUDGET} />
        </div>

        {/* terminal -> floor panel (one shared surface) */}
        <div style={{ position: "absolute", left: L.floor.x, top: L.floor.y, width: L.floor.w, height: termH, ...panelStyle, overflow: "hidden", opacity: appear(t, b(7)) }}>
          <div style={{ position: "absolute", inset: 0, padding: "16px 18px", fontFamily: FONT.mono, fontSize: 14, lineHeight: 1.6, color: C.text, opacity: termText, whiteSpace: "pre-wrap" }}>
            <span style={{ color: C.faint }}>$ </span>
            {typed}
            {t < TYPE_TO + 0.2 && Math.floor(t * 4) % 2 === 0 ? <span style={{ background: C.text }}>&nbsp;</span> : null}
            {t >= b(8, 1) ? <div style={{ color: C.muted, marginTop: 8, opacity: appear(t, b(8, 1), 0.15) }}>{WROTE}</div> : null}
          </div>
          <div style={{ position: "absolute", left: 16, top: 12, display: "flex", alignItems: "baseline", gap: 10, opacity: panelTitles }}>
            <span style={{ fontFamily: FONT.pixel, fontSize: 17, fontWeight: 600, color: C.text }}>The floor</span>
            <span style={{ fontSize: 12, color: C.muted, fontFamily: FONT.body }}>{`7 agents, ${run.active} active`}</span>
          </div>
          {["Start", "Wave 2", "Wave 3"].map((label, col) => (
            <div key={label} style={{ position: "absolute", left: L.colX[col] - L.floor.x, top: 70, fontFamily: FONT.pixel, fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: C.faint, opacity: appear(t, deskAt(col, 0) - 0.1) }}>
              {label}
            </div>
          ))}
        </div>

        {/* the goal travels from the command's quotes to the floor's goal line */}
        {t >= MORPH ? (
          <div style={{
            position: "absolute", fontFamily: goalFly < 0.5 ? FONT.mono : FONT.body, whiteSpace: "nowrap",
            left: L.floor.x + 16 + (1 - goalFly) * 116, top: L.floor.y + 40 - (1 - goalFly) * 24,
            fontSize: 14 - goalFly, color: goalFly < 0.5 ? C.text : C.muted,
          }}>
            {GOAL}
          </div>
        ) : null}

        <Threads t={t} />

        {TASKS.map((task, i) => {
          const at = deskAt(task.col, task.row);
          if (t < at) return null;
          const u = step(t - at, { stiffness: 320, damping: 30 });
          const s = run.tasks[i].state;
          return (
            <Desk key={task.id} t={t} title={task.title} id={task.id} color={task.color} state={s} phase={(task.col * 3 + task.row * 5) % 8}
              style={{ left: L.colX[task.col], top: L.rowY[task.row] + (1 - u) * 18, opacity: clamp01(u * 1.4) }} />
          );
        })}

        {/* side: the braid */}
        <div style={{ position: "absolute", left: L.side.x + (1 - side) * 60, top: L.side.y, width: L.side.w, height: L.side.h, ...panelStyle, opacity: clamp01(side * 1.3) }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "12px 16px 0" }}>
            <span style={{ fontFamily: FONT.pixel, fontSize: 17, fontWeight: 600, color: C.text }}>The braid</span>
            <span style={{ fontSize: 12, color: C.muted, fontFamily: FONT.body }}>integration branch</span>
          </div>
          <div data-target="branch" style={{ fontFamily: FONT.mono, fontSize: 11.5, color: C.muted, padding: "2px 16px 0", overflowWrap: "anywhere" }}>{BRANCH}</div>
          <BraidRope t={t} />
        </div>
      </div>
    </div>
  );
}

function BraidRope({ t }: { t: number }) {
  const done = MERGES.filter((m) => t >= m.at);
  const grow = done.map((m) => ease(clamp01((t - m.at) / 0.35)));
  const seg = 46, top = 14;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "54px 1fr", padding: "10px 16px 16px" }}>
      <Rope colors={done.map((m) => m.task.color)} grow={grow} total={7} />
      <div style={{ position: "relative", fontFamily: FONT.body }}>
        {done.map((m, i) => (
          <div key={m.task.id} style={{ position: "absolute", left: 0, right: 0, top: top + i * seg + seg / 2, translate: "0 -50%", display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, opacity: grow[i] }}>
            <b style={{ color: m.task.color, fontWeight: 600 }}>{m.task.id}</b>
            <span style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.task.title}</span>
          </div>
        ))}
        {done.length < 7 ? (
          <div style={{ position: "absolute", top: top + done.length * seg + 22, translate: "0 -50%", fontSize: 12.5, color: C.muted }}>
            {`${7 - done.length} strand${7 - done.length > 1 ? "s" : ""} to go`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** drawThreads: dependency curves from each dep's right edge to the task's left edge. */
function Threads({ t }: { t: number }) {
  const run = runState(t);
  const live = ["running", "verifying", "reviewing", "merging"];
  return (
    <svg width={L.W} height={560} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
      {TASKS.flatMap((task, i) =>
        task.deps.map((dep) => {
          const from = TASKS.find((x) => x.id === dep)!;
          const x1 = L.colX[from.col] + L.deskW, y1 = L.rowY[from.row] + L.deskH / 2;
          const x2 = L.colX[task.col], y2 = L.rowY[task.row] + L.deskH / 2;
          const mx = (x1 + x2) / 2;
          const draw = inOut(clamp01((t - (b(10) + task.col * 0.2)) / 0.6));
          const isLive = live.includes(run.tasks[i].state.status);
          return (
            <g key={`${dep}-${task.id}`}>
              <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={from.color} strokeWidth={3} strokeLinecap="round"
                pathLength={isLive ? undefined : 100} strokeDasharray={isLive ? "2 7" : "100 100"} strokeDashoffset={isLive ? -(t / 0.7) * 9 : 100 - draw * 100}
                opacity={isLive ? 0.95 : draw > 0.01 ? 0.55 : 0} />
            </g>
          );
        }),
      )}
    </svg>
  );
}
