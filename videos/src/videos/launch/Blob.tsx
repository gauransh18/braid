import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { C } from "./tokens";

/**
 * Frame-driven twin of `drawBlob` in ui/index.html. The painter is copied as is; only the clock
 * changes: the dashboard bumps `frame` every 125 ms on a setInterval, the film passes
 * f = floor(t * 8) + phase, so each frame is a pure function of time.
 */
function hexToRgb(h: string) {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function mix(h: string, target: "black" | "white", amt: number) {
  const a = hexToRgb(h), b = target === "black" ? [18, 16, 30] : [255, 255, 255];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amt)).join(",")})`;
}

export function drawBlob(ctx: CanvasRenderingContext2D, base: string, mood: string, f: number, tuft?: string[]) {
  const ink = C.spriteInk;
  ctx.clearRect(0, 0, 20, 20);
  const color = base;
  ctx.globalAlpha = 1;
  const px = (x: number, y: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); };

  let rx = 6.5, ry = 5.5, cy = 12.5, bob = 0;
  if (mood === "work") bob = [0, -1, 0, 0][f % 4];
  if (mood === "jump") bob = [0, -2, -3, -2][f % 4];
  if (mood === "happy") bob = [0, -1][f % 2];
  if (mood === "sleep") { rx = 6.5 + (f % 8 < 4 ? .3 : 0); ry = 5.5 - (f % 8 < 4 ? .3 : 0); }
  if (mood === "dead") { rx = 8.2; ry = 3.2; cy = 15.5; }
  cy += bob;

  const inside = (x: number, y: number) => { const dx = (x + .5 - 10) / rx, dy = (y + .5 - cy) / ry; return dx * dx + dy * dy <= 1 && y <= 17; };
  const edge = mix(color, "black", .45), light = mix(color, "white", .5);
  let top = 20;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    if (!inside(x, y)) continue;
    top = Math.min(top, y);
    const border = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    px(x, y, border ? edge : color);
  }
  if (mood !== "dead") { px(6, top + 2, light); px(7, top + 1, light); px(6, top + 1, light); }

  if (mood !== "dead") {
    const strands = tuft || [mix(color, "white", .35), edge, color];
    const sway = mood === "work" || mood === "jump" ? (f % 4 < 2 ? 0 : 1) : 0;
    for (let k = 1; k <= 4; k++) {
      const x = 9 + ((k + sway) % 2);
      px(x, top - k, strands[k % strands.length]);
      px(x === 9 ? 10 : 9, top - k, k === 4 ? strands[(k + 1) % strands.length] : "transparent");
    }
    px(9, top - 5, strands[0]); px(11, top - 5, strands[1]); px(10, top - 5, strands[2]);
  }

  const ey = Math.round(cy) - 1;
  const blink = f % 26 === 0;
  const eyes = (lx: number, rx2: number, y: number, h = 2) => { for (let i = 0; i < h; i++) { px(lx, y + i, ink); px(rx2, y + i, ink); } };
  switch (mood) {
    case "sleep": {
      px(6, ey + 1, ink); px(7, ey + 1, ink); px(12, ey + 1, ink); px(13, ey + 1, ink);
      const zy = 5 - Math.floor((f % 12) / 3); const zx = 15; ctx.globalAlpha *= .9;
      [[0,0],[1,0],[2,0],[1,1],[0,2],[1,2],[2,2]].forEach(([a, b]) => px(zx + a, zy + b, "rgba(140,140,170,.9)"));
      ctx.globalAlpha = 1;
      break;
    }
    case "happy":
      [[6,1],[7,0],[8,1],[11,1],[12,0],[13,1]].forEach(([x, d]) => px(x, ey + d, ink));
      px(9, ey + 3, ink); px(10, ey + 3, ink);
      if (f % 6 < 3) { px(3, top, "#ffe27a"); px(16, top + 1, "#ffe27a"); } else { px(2, top + 2, "#ffe27a"); px(17, top - 1, "#ffe27a"); }
      break;
    case "dead":
      [[6,0],[8,0],[7,1],[6,2],[8,2],[11,0],[13,0],[12,1],[11,2],[13,2]].forEach(([x, d]) => px(x, Math.round(cy) - 2 + d, ink));
      break;
    case "inspect": {
      const look = f % 8 < 4 ? 1 : 0;
      eyes(7 + look, 12 + look, ey, blink ? 1 : 2);
      [[14,7],[15,7],[16,7],[13,8],[17,8],[13,9],[17,9],[14,10],[15,10],[16,10]].forEach(([x, y]) => px(x, y + bob, "#c9c6d8"));
      px(15, 8 + bob, "rgba(160,210,255,.8)"); px(15, 9 + bob, "rgba(160,210,255,.6)");
      px(17, 11 + bob, "#8a6a4a"); px(18, 12 + bob, "#8a6a4a");
      break;
    }
    case "review":
      eyes(7, 12, ey, blink ? 1 : 2);
      for (let x = 5; x <= 14; x++) if (x !== 9 && x !== 10) px(x, ey - 1, ink);
      px(5, ey, ink); px(9, ey, ink); px(10, ey, ink); px(14, ey, ink);
      px(5, ey + 2, ink); px(9, ey + 2, ink); px(10, ey + 2, ink); px(14, ey + 2, ink);
      px(9, ey - 1, ink); px(10, ey - 1, ink);
      break;
    case "work": {
      eyes(7, 12, ey + 1, blink ? 1 : 2);
      const ly = Math.round(cy) + 3 - bob;
      for (let x = 5; x <= 14; x++) { px(x, ly + 1, "#7f7c92"); }
      for (let x = 6; x <= 13; x++) { px(x, ly, "#9c99b0"); }
      px(8 + (f % 4), ly, mix(base, "white", .3));
      if (f % 4 < 2) { px(16, top + 1, "#fff"); } else { px(3, top + 2, "#fff"); }
      break;
    }
    case "jump":
      [[6,1],[7,0],[8,1],[11,1],[12,0],[13,1]].forEach(([x, d]) => px(x, ey + d, ink));
      px(9, ey + 3, ink); px(10, ey + 3, ink);
      break;
    default:
      eyes(7, 12, ey, blink ? 1 : 2);
      px(9, ey + 3, ink); px(10, ey + 3, ink);
  }
  ctx.globalAlpha = 1;
}

/** A sprite at any size. `t` in seconds; the dashboard animates sprites at 8 fps. */
export function Blob({ t, color, mood, size, phase = 0, tuft, style }: {
  t: number; color: string; mood: string; size: number; phase?: number; tuft?: string[]; style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const f = Math.max(0, Math.floor(t * 8)) + phase;
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) drawBlob(ctx, color, mood, f, tuft);
  }, [color, mood, f, tuft]);
  return <canvas ref={ref} width={20} height={20} style={{ width: size, height: size, imageRendering: "pixelated", display: "block", ...style }} />;
}
