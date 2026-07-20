import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "./config";
import { readKeyframesSource } from "./ingest";
import { resolveRouterPaths } from "./pipeline/router/resolve";
import { readRunstate } from "./runstate";

export type OutputFile = {
  name: string;
  size: number;
  mtime: number;
  scene: string | null;
  variant: string | null;
};

function resolveProvider(projectName: string, provider?: string | null): string {
  if (provider === "firefly" || provider === "hailuo") return provider;
  const rs = readRunstate();
  if (rs?.project === projectName && rs.provider) return rs.provider;
  return "hailuo";
}

function outputDirForProject(projectName: string, provider?: string | null): string | null {
  const root = path.join(PROJECTS_ROOT, projectName);
  if (!fs.existsSync(root)) return null;
  const kfSource = readKeyframesSource(root);
  const prov = resolveProvider(projectName, provider);
  return resolveRouterPaths(prov, root, kfSource).outputDir;
}

export function listProjectOutputs(
  projectName: string,
  provider?: string | null,
): {
  dir: string | null;
  files: OutputFile[];
  provider: string;
} {
  const prov = resolveProvider(projectName, provider);
  const dir = outputDirForProject(projectName, prov);
  if (!dir || !fs.existsSync(dir)) return { dir, files: [], provider: prov };

  const files = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith(".mp4"))
    .map((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size <= 0) return null;
      const m = name.match(/^(scene_\d+)_.*_(v[123])\.mp4$/i);
      return {
        name,
        size: st.size,
        mtime: st.mtimeMs,
        scene: m?.[1] ?? null,
        variant: m?.[2]?.toLowerCase() ?? null,
      };
    })
    .filter((f): f is OutputFile => f !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { dir, files, provider: prov };
}

/** Path traversal korumalı — yalnız proje çıktı klasöründeki .mp4 */
export function resolveOutputFile(
  projectName: string,
  fileName: string,
  provider?: string | null,
): string | null {
  const safe = path.basename(String(fileName || "").trim());
  if (!safe || safe !== fileName || !safe.toLowerCase().endsWith(".mp4")) return null;

  const dir = outputDirForProject(projectName, provider);
  if (!dir) return null;

  const full = path.resolve(dir, safe);
  const root = path.resolve(dir);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  if (!fs.existsSync(full)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function outputFolderLabel(provider: string): string {
  return provider === "firefly" ? "firefly_videos/" : "hailuo_router_videos/";
}
