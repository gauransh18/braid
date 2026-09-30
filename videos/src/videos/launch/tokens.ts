/** Dark theme tokens from ui/index.html (:root dark). Hex only, so they can animate. */
export const C = {
  bg: "#12131c",
  bg2: "#171926",
  panel: "#1d1f2d",
  panel2: "#232638",
  line: "#2c2f44",
  line2: "#3a3e58",
  text: "#ecebf5",
  muted: "#9a9cb3",
  faint: "#666985",
  accent: "#b48cff",
  accentSoft: "#2c2448",
  ok: "#3fcf8e",
  warn: "#f5b942",
  err: "#ff6b6b",
  info: "#6cb6ff",
  okSoft: "#173327",
  warnSoft: "#3a2f16",
  errSoft: "#3b1d22",
  infoSoft: "#182a40",
  weave: "rgba(255,255,255,.025)",
  spriteInk: "#12131c",
  shadow: "0 1px 0 rgba(0,0,0,.3), 0 10px 24px -12px rgba(0,0,0,.6)",
} as const;

export const TASK_COLORS = ["#ff7a90", "#3cc8b4", "#f5b942", "#9b7bff", "#5aa9ff", "#8fd14f", "#ff9a4d", "#e86bd0"];
export const KNOT = { color: "#b48cff", tuft: ["#ff7a90", "#3cc8b4", "#f5b942"] };

export const FONT = {
  pixel: '"Pixelify Sans", ui-monospace, monospace',
  mono: '"JetBrains Mono", ui-monospace, Consolas, monospace',
  body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

export const MOOD: Record<string, string> = {
  pending: "sleep", running: "work", resolving: "inspect", verifying: "inspect", reviewing: "review",
  merging: "jump", done: "happy", failed: "dead", blocked: "tied",
};
