"""Tile PNG stills into one sheet: python3 scripts/sheet.py <dir> [cols] [width]"""
import subprocess, sys, pathlib, re, imageio_ffmpeg
d = pathlib.Path(sys.argv[1]); cols = int(sys.argv[2]) if len(sys.argv) > 2 else 4; w = int(sys.argv[3]) if len(sys.argv) > 3 else 640
files = sorted([p for p in d.glob("f*.png")], key=lambda p: int(re.findall(r"\d+", p.stem)[0]))
h = w * 9 // 16
args = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y"]
for f in files: args += ["-i", str(f)]
fc = "".join(f"[{i}:v]scale={w}:{h},drawtext=text='{f.stem}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6[v{i}];" for i, f in enumerate(files))
fc += "".join(f"[v{i}]" for i in range(len(files))) + f"xstack=inputs={len(files)}:layout=" + "|".join(f"{(i%cols)*w}_{(i//cols)*h}" for i in range(len(files))) + ":fill=black"
subprocess.run(args + ["-filter_complex", fc, str(d / "sheet.png")], check=True)
print(d / "sheet.png")
