import fs from "fs";
import path from "path";
import sharp from "sharp";
import type { ProjectPaths } from "./project";

export function findFrameIn(
  dir: string | null,
  label: string,
  frameType: "first" | "last",
): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const ext of [".jpg", ".png"]) {
    const p = path.join(dir, label, `frame_${frameType}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function findFrame(
  paths: ProjectPaths,
  label: string,
  frameType: "first" | "last",
): string | null {
  return (
    findFrameIn(paths.keyframesSwappedDir, label, frameType) ||
    findFrameIn(paths.keyframesOrigDir, label, frameType)
  );
}

export function findFramePair(
  paths: ProjectPaths,
  label: string,
  frameType: "first" | "last",
  swapOn: boolean,
): { swap: string | null; orig: string | null } {
  const fpSwap = findFrame(paths, label, frameType);
  let fpOrig: string | null = null;
  if (
    swapOn &&
    paths.keyframesOrigDir !== paths.keyframesSwappedDir
  ) {
    const cand = findFrameIn(paths.keyframesOrigDir, label, frameType);
    if (cand && cand !== fpSwap) fpOrig = cand;
  }
  return { swap: fpSwap, orig: fpOrig };
}

export async function encodeImage(filePath: string): Promise<Buffer | null> {
  try {
    const img = sharp(filePath);
    const meta = await img.metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const max = Math.max(w, h);
    let pipeline = img;
    if (max > 1024) {
      const r = 1024 / max;
      pipeline = pipeline.resize(Math.round(w * r), Math.round(h * r));
    }
    return await pipeline.jpeg({ quality: 85 }).toBuffer();
  } catch {
    return null;
  }
}

export function loadSwapFlag(paths: ProjectPaths): boolean {
  if (!fs.existsSync(paths.swapFlagFile)) return false;
  const v = fs.readFileSync(paths.swapFlagFile, "utf8").trim().toLowerCase();
  return v === "yes";
}

export async function loadCharRefs(
  paths: ProjectPaths,
): Promise<{ name: string; data: Buffer }[]> {
  if (!fs.existsSync(paths.charRefsDir)) return [];
  const exts = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  const out: { name: string; data: Buffer }[] = [];
  for (const f of fs.readdirSync(paths.charRefsDir).sort()) {
    if (!exts.has(path.extname(f).toLowerCase())) continue;
    const buf = await encodeImage(path.join(paths.charRefsDir, f));
    if (buf) out.push({ name: path.basename(f, path.extname(f)), data: buf });
  }
  return out;
}
