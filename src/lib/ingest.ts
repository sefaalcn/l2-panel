import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { PROJECTS_ROOT } from "./config";

export type KeyframesSource = "original" | "swapped";

export const KEYFRAMES_SOURCE_FILE = ".l2_keyframes_source";

export function safeProjectName(name: string): string {
  let n = (name || "").trim().replace(/[<>:"/\\|?*]/g, "_").replace(/^\.+|\.+$/g, "");
  if (!n) n = "project";
  return n.slice(0, 120);
}

export function parseKeyframesSource(v: unknown): KeyframesSource {
  return String(v || "").trim().toLowerCase() === "swapped" ? "swapped" : "original";
}

export function keyframesDirName(source: KeyframesSource): string {
  return source === "swapped" ? "keyframes_swapped" : "keyframes";
}

export function readKeyframesSource(projectDir: string): KeyframesSource {
  const f = path.join(projectDir, KEYFRAMES_SOURCE_FILE);
  if (!fs.existsSync(f)) return "original";
  try {
    return parseKeyframesSource(fs.readFileSync(f, "utf8"));
  } catch {
    return "original";
  }
}

/** ZIP içindeki yolu seçilen köke (keyframes/ veya keyframes_swapped/) map'ler. */
function remapZipEntry(name: string, targetRoot: string): string | null {
  let n = name.replace(/\\/g, "/");
  if (n.startsWith("__MACOSX") || n.endsWith(".DS_Store")) return null;
  if (n.endsWith(".json") && n.toLowerCase().includes("scenes") && !n.includes("/")) return null;

  if (n.startsWith("keyframes_swapped/")) {
    return `${targetRoot}/${n.slice("keyframes_swapped/".length)}`;
  }
  if (n.startsWith("keyframes/")) {
    return `${targetRoot}/${n.slice("keyframes/".length)}`;
  }
  // Düz scene_XXX/... veya frame_* içeren göreli yollar
  if (/^scene[^/]+\//i.test(n) || /(^|\/)frame_/i.test(n) || /(^|\/)(first|last)_frame/i.test(n)) {
    return `${targetRoot}/${n}`;
  }
  return null;
}

export function materializeExport(opts: {
  project: string;
  scenesBytes: Buffer;
  zipBytes: Buffer;
  videoBytes?: Buffer | null;
  videoName?: string | null;
  keyframesSource?: KeyframesSource;
}) {
  const project = safeProjectName(opts.project);
  const source = opts.keyframesSource || "original";
  const targetRoot = keyframesDirName(source);
  const root = path.join(PROJECTS_ROOT, project);
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(path.join(root, `${project}_scenes_manual.json`), opts.scenesBytes);
  fs.writeFileSync(path.join(root, KEYFRAMES_SOURCE_FILE), source, "utf8");

  const zip = new AdmZip(opts.zipBytes);
  let extracted = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const mapped = remapZipEntry(entry.entryName, targetRoot);
    if (!mapped) continue;
    const target = path.join(root, mapped);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    extracted += 1;
  }

  let videoWritten: string | null = null;
  if (opts.videoBytes && opts.videoBytes.length) {
    let vname = opts.videoName || `${project}.mp4`;
    vname = path.basename(vname);
    if (!/\.(mp4|mov|webm|mkv)$/i.test(vname)) vname = `${project}.mp4`;
    fs.writeFileSync(path.join(root, vname), opts.videoBytes);
    videoWritten = vname;
  }

  const kfDir = path.join(root, targetRoot);
  const hasKf = fs.existsSync(kfDir) && fs.readdirSync(kfDir).length > 0;
  return {
    project,
    path: root,
    keyframes_source: source,
    has_keyframes: hasKf,
    video: videoWritten,
    extracted: { keyframes: extracted, root: targetRoot },
  };
}
