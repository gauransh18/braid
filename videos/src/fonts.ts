import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

const faces: [family: string, file: string, weight: string][] = [
  ["Pixelify Sans", "pixelify-sans-latin-400-normal.woff2", "400"],
  ["Pixelify Sans", "pixelify-sans-latin-600-normal.woff2", "600"],
  ["Pixelify Sans", "pixelify-sans-latin-700-normal.woff2", "700"],
  ["JetBrains Mono", "jetbrains-mono-latin-400-normal.woff2", "400"],
  ["JetBrains Mono", "jetbrains-mono-latin-600-normal.woff2", "600"],
];

export const fontsReady = Promise.all(faces.map(([family, file, weight]) => loadFont({ family, url: staticFile(`fonts/${file}`), weight })));
