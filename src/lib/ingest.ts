import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { PROJECTS_ROOT } from "./config";

export function safeProjectName(name: string): string {
  let n = (name || "").trim().replace(/[<>:"/\\|?*]/g, "_").replace(/^\.+|\.+$/g, "");
  if (!n) n = "project";
  return n.slice(0, 120);
}

export function materializeExport(opts: {
  project: string;
  scenesBytes: Buffer;
  zipBytes: Buffer;
  videoBytes?: Buffer | null;
  videoName?: string | null;
}) {
  const project = safeProjectName(opts.project);
  const root = path.join(PROJECTS_ROOT, project);
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(path.join(root, `${project}_scenes_manual.json`), opts.scenesBytes);

  const zip = new AdmZip(opts.zipBytes);
  let keyframes = 0;
  let other = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    let name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("__MACOSX") || name.endsWith(".DS_Store")) continue;
    if (name.endsWith(".json") && name.toLowerCase().includes("scenes") && !name.includes("/")) {
      continue;
    }
    if (
      !name.startsWith("keyframes/") &&
      !name.startsWith("keyframes_swapped/")
    ) {
      continue;
    }
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    if (name.startsWith("keyframes/")) keyframes += 1;
    else other += 1;
  }

  let videoWritten: string | null = null;
  if (opts.videoBytes && opts.videoBytes.length) {
    let vname = opts.videoName || `${project}.mp4`;
    vname = path.basename(vname);
    if (!/\.(mp4|mov|webm|mkv)$/i.test(vname)) vname = `${project}.mp4`;
    fs.writeFileSync(path.join(root, vname), opts.videoBytes);
    videoWritten = vname;
  }

  const kfDir = path.join(root, "keyframes");
  const hasKf = fs.existsSync(kfDir) && fs.readdirSync(kfDir).length > 0;
  return {
    project,
    path: root,
    has_keyframes: hasKf,
    video: videoWritten,
    extracted: { keyframes, other },
  };
}
