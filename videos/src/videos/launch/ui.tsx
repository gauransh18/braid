import type { CSSProperties, ReactNode } from "react";
import { Blob } from "./Blob";
import { C, FONT, MOOD } from "./tokens";
import { MAX_ATTEMPTS, fmtTok, fmtUsd, type TaskState } from "./floor";
import { clamp01 } from "../../kit/time";

/** Twins of the dashboard's DOM pieces (ui/index.html). Same tokens and sizes, no hover or CSS transitions. */

export const L = {
  W: 1136,
  header: { y: 0, h: 64 },
  floor: { x: 16, y: 80, w: 788, h: 440 },
  side: { x: 820, y: 80, w: 300, h: 440 },
  colX: [32, 300, 568],
  rowY: [168, 264, 360],
  deskW: 220,
  deskH: 80,
};

export const weave = (pitch = 12, line = 2): CSSProperties => ({
  backgroundColor: C.bg,
  backgroundImage: `repeating-linear-gradient(0deg, ${C.weave} 0 ${line}px, transparent ${line}px ${pitch}px), repeating-linear-gradient(90deg, ${C.weave} 0 ${line}px, transparent ${line}px ${pitch}px)`,
});

export const panelStyle: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  boxShadow: C.shadow,
};

const CHIP: Record<string, [string, string]> = {
  running: [C.infoSoft, C.info], verifying: [C.infoSoft, C.info], reviewing: [C.infoSoft, C.info], merging: [C.infoSoft, C.info],
  resolving: [C.infoSoft, C.info], done: [C.okSoft, C.ok], failed: [C.errSoft, C.err], pending: [C.line, C.muted],
};

export function Chip({ status }: { status: string }) {
  const [bg, fg] = CHIP[status] ?? CHIP.pending;
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: bg, color: fg, textTransform: "lowercase", fontFamily: FONT.body }}>
      {status}
    </span>
  );
}

export function Desk({ t, title, id, color, state, phase = 0, style, mood }: {
  t: number; title: string; id: string; color: string; state: TaskState & { status: string }; phase?: number; style?: CSSProperties; mood?: string;
}) {
  return (
    <div
      data-target={`desk-${id}`}
      style={{
        position: "absolute", width: L.deskW, height: L.deskH, boxSizing: "border-box",
        display: "grid", gridTemplateColumns: "56px 1fr", gap: "4px 10px", alignItems: "center",
        padding: "10px 12px 10px 8px", borderRadius: 12, background: C.panel2, border: `2px solid ${C.line}`,
        fontFamily: FONT.body, color: C.text, ...style,
      }}
    >
      <div style={{ position: "absolute", left: -2, top: 12, bottom: 12, width: 4, borderRadius: "0 3px 3px 0", background: color }} />
      <Blob t={t} color={color} mood={mood ?? MOOD[state.status] ?? "sleep"} size={56} phase={phase} style={{ gridRow: "span 3" }} />
      <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
      <div style={{ fontSize: 12, color: C.muted, fontFamily: FONT.mono }}>{id}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "4px 8px", fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
        <Chip status={state.status} />
        <span style={{ display: "inline-flex", gap: 3 }}>
          {Array.from({ length: MAX_ATTEMPTS }, (_, i) => {
            const used = i < state.attempts;
            const bad = used && i < state.failed;
            return <i key={i} style={{ width: 7, height: 7, borderRadius: 2, background: bad ? C.err : used ? color : C.line2 }} />;
          })}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: FONT.mono, fontVariantNumeric: "tabular-nums" }}>
          {state.tokens ? `${fmtTok(state.tokens)} tok · ` : ""}{fmtUsd(state.cost)}
        </span>
      </div>
    </div>
  );
}

/** Knot's speech bubble (.bubble): text types in at `cps` characters per second from `since`. */
export function Bubble({ t, text, since, cps = 70, style, maxWidth = 440 }: {
  t: number; text: string; since: number; cps?: number; style?: CSSProperties; maxWidth?: number;
}) {
  const shown = Math.max(0, Math.floor((t - since) * cps));
  const done = text.slice(0, shown);
  return (
    <div style={{ position: "absolute", maxWidth, padding: "7px 12px", borderRadius: 10, background: C.panel, border: `2px solid ${C.line2}`, fontSize: 13, lineHeight: 1.45, color: C.text, fontFamily: FONT.body, boxShadow: C.shadow, ...style }}>
      <div style={{ position: "absolute", left: -8, top: "50%", width: 10, height: 10, marginTop: -5, background: C.panel, borderLeft: `2px solid ${C.line2}`, borderBottom: `2px solid ${C.line2}`, rotate: "45deg" }} />
      {/* keep the full text's box so the bubble never reflows while typing */}
      <span style={{ position: "relative" }}>
        {done}
        <span style={{ visibility: "hidden" }}>{text.slice(done.length)}</span>
      </span>
    </div>
  );
}

export function Stat({ label, value, sub, meter, meterColor = C.accent, style }: {
  label: string; value: ReactNode; sub?: ReactNode; meter?: number; meterColor?: string; style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 110, fontFamily: FONT.body, ...style }}>
      <span style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 14, color: C.text }}>{value}</span>
      {sub ? <span style={{ fontFamily: FONT.mono, fontSize: 12, color: C.muted }}>{sub}</span> : null}
      {meter !== undefined ? (
        <div style={{ height: 6, borderRadius: 3, background: C.line, overflow: "hidden" }}>
          <i style={{ display: "block", height: "100%", width: `${clamp01(meter) * 100}%`, background: meterColor }} />
        </div>
      ) : null}
    </div>
  );
}

export function Pill({ children, fg = C.muted, bg = C.panel2, border = C.line, square = true }: { children: ReactNode; fg?: string; bg?: string; border?: string; square?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: fg, border: `1px solid ${border}`, whiteSpace: "nowrap", fontFamily: FONT.body }}>
      {square ? <i style={{ width: 7, height: 7, borderRadius: 2, background: fg }} /> : null}
      {children}
    </span>
  );
}

/**
 * The braid rope (renderBraid): three sine strands, one segment per verified merge, a bead in the
 * task's color, and a dashed tail for the strands still to go. `grow` is 0..1 per merged segment.
 */
export function Rope({ colors, grow, total, showTail = true, knotTop = true }: {
  colors: string[]; grow: number[]; total: number; showTail?: boolean; knotTop?: boolean;
}) {
  const seg = 46, top = 14, W = 54, cx = 27;
  const merged = colors.length;
  const remaining = Math.max(0, total - merged);
  const h = top + merged * seg + (remaining ? 40 : 10);
  const strands = [0, 1, 2].flatMap((k) =>
    colors.map((_, i) => {
      const y0 = top + i * seg;
      const pts: string[] = [];
      for (let s = 0; s <= 12; s++) {
        const y = y0 + (s / 12) * seg;
        const x = cx + Math.sin(((y - top) / seg) * Math.PI * 2 + k * ((Math.PI * 2) / 3)) * 11;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      const col = colors[(i + k) % merged] ?? colors[i];
      const g = clamp01(grow[i] ?? 1);
      return (
        <polyline key={`${k}-${i}`} points={pts.join(" ")} stroke={col} strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round"
          pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - g} opacity={g > 0 ? 1 : 0} />
      );
    }),
  );
  const tailY = top + merged * seg;
  return (
    <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} style={{ display: "block", overflow: "visible" }}>
      {knotTop ? <rect x={cx - 14} y={2} width={28} height={10} rx={3} fill={C.line2} /> : null}
      {strands}
      {showTail && remaining
        ? [-11, 0, 11].map((dx) => <line key={dx} x1={cx + dx} y1={tailY} x2={cx + dx} y2={h} stroke={C.line2} strokeWidth={3} strokeDasharray="3 5" />)
        : null}
      {colors.map((c, i) => {
        const y = top + i * seg + seg / 2;
        const g = clamp01((grow[i] ?? 1) * 2 - 1);
        return <rect key={i} x={cx - 7} y={y - 7} width={14} height={14} rx={3} fill={c} stroke={C.panel} strokeWidth={2} opacity={g} />;
      })}
    </svg>
  );
}
