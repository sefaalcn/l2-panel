import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export function which(cmd: string): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  const ext = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of paths) {
    for (const e of ext) {
      const p = path.join(dir, cmd + e);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export async function compressVideo(src: string): Promise<string> {
  const dir = path.dirname(src);
  const base = path.basename(src, path.extname(src));
  const comp = path.join(dir, `${base}_small.mp4`);
  if (fs.existsSync(comp)) return comp;
  if (!which("ffmpeg")) return src;

  return new Promise((resolve) => {
    const args = [
      "-i",
      src,
      "-vf",
      "scale=-2:720",
      "-c:v",
      "libx264",
      "-crf",
      "28",
      "-preset",
      "fast",
      "-an",
      "-y",
      comp,
    ];
    const child = spawn("ffmpeg", args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(src);
    }, 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(comp) ? comp : src);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(src);
    });
  });
}
