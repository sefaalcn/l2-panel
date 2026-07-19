import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "./config";
import {
  keyframesDirName,
  parseKeyframesSource,
  readKeyframesSource,
  type KeyframesSource,
} from "./ingest";

export type ProjectSummary = {
  name: string;
  has_scenes_json: boolean;
  scenes_json: string | null;
  version: number | string | null;
  has_keyframes: boolean;
  has_keyframes_swapped: boolean;
  keyframes_source: KeyframesSource;
  has_prompts: boolean;
  has_video: boolean;
  scene_count: number | null;
};

function dirHasFiles(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

function sourceScenesJson(proj: string): string | null {
  const dir = path.join(PROJECTS_ROOT, proj);
  if (!fs.existsSync(dir)) return null;
  const cands = fs
    .readdirSync(dir)
    .filter(
      (n) =>
        n.includes("scenes") &&
        n.endsWith(".json") &&
        !n.toLowerCase().includes("progress") &&
        !n.includes("_output"),
    );
  return cands[0] || null;
}

export function projectSummary(name: string): ProjectSummary {
  const dir = path.join(PROJECTS_ROOT, name);
  const scenesName = sourceScenesJson(name);
  const kf = path.join(dir, "keyframes");
  const kfSwap = path.join(dir, "keyframes_swapped");
  const prompts = path.join(dir, `${name}_output`, "hailuo_prompts_claude.json");
  let sceneCount: number | null = null;
  let version: number | string | null = null;
  if (scenesName) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, scenesName), "utf8"));
      const sc = Array.isArray(raw) ? raw : raw.scenes || [];
      sceneCount = sc.length;
      version = typeof raw === "object" && !Array.isArray(raw) ? raw.version ?? null : null;
    } catch {
      /* */
    }
  }
  const hasVideo =
    fs.existsSync(dir) &&
    fs.readdirSync(dir).some((n) => {
      const low = n.toLowerCase();
      return low.endsWith(".mp4") && !low.includes("_small");
    });
  const hasOrig = dirHasFiles(kf);
  const hasSwap = dirHasFiles(kfSwap);
  let keyframesSource = readKeyframesSource(dir);
  // Tercih dosyası yoksa: hangisi varsa onu kullan
  if (!fs.existsSync(path.join(dir, ".l2_keyframes_source"))) {
    if (hasSwap && !hasOrig) keyframesSource = "swapped";
    else keyframesSource = "original";
  }
  return {
    name,
    has_scenes_json: Boolean(scenesName),
    scenes_json: scenesName,
    version,
    has_keyframes: hasOrig,
    has_keyframes_swapped: hasSwap,
    keyframes_source: keyframesSource,
    has_prompts: fs.existsSync(prompts),
    has_video: hasVideo,
    scene_count: sceneCount,
  };
}

export function listProjects(): ProjectSummary[] {
  if (!fs.existsSync(PROJECTS_ROOT)) fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  return fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "OLD")
    .map((d) => projectSummary(d.name))
    .filter((s) => s.has_scenes_json || s.has_keyframes || s.has_keyframes_swapped || s.has_video)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function preflight(name: string, sourceOverride?: KeyframesSource | null) {
  const dir = path.join(PROJECTS_ROOT, name);
  if (!fs.existsSync(dir)) return null;
  const s = projectSummary(name);
  const source = sourceOverride
    ? parseKeyframesSource(sourceOverride)
    : s.keyframes_source;
  const kfRoot = keyframesDirName(source);
  const kfDir = path.join(dir, kfRoot);
  const hasActiveKf = dirHasFiles(kfDir);

  const scenesName = s.scenes_json;
  if (!scenesName) {
    return {
      name,
      scene_count: null,
      warnings: ["kaynak scenes JSON yok"],
      prompts_ready: s.has_prompts,
      has_video: s.has_video,
      keyframes_source: source,
      scenario: "B-eksik" as const,
    };
  }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, scenesName), "utf8"));
  const sc: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw.scenes || [];
  const warnings: string[] = [];
  if (!hasActiveKf) {
    warnings.push(
      `${kfRoot}/ boş veya yok — keyframes ZIP yükle (kaynak: ${source})`,
    );
  }
  let scenario: "A" | "B" | "B-eksik";
  if (s.has_prompts) scenario = "A";
  else if (s.has_video) {
    scenario = "B";
    warnings.push("prompt YOK → gemini_direct üretecek (kaynak video ✓)");
  } else {
    scenario = "B-eksik";
    warnings.push("prompt YOK ve kaynak video (.mp4) YOK → prompt üretilemez");
  }
  for (const scene of sc) {
    const mode = String(scene.frame_mode || "both");
    const label = String(scene.label || `scene_${String(scene.index || 0).padStart(3, "0")}`);
    const firstJpg = path.join(kfDir, label, "frame_first.jpg");
    const firstPng = path.join(kfDir, label, "frame_first.png");
    const lastJpg = path.join(kfDir, label, "frame_last.jpg");
    const lastPng = path.join(kfDir, label, "frame_last.png");
    const hasFirst = fs.existsSync(firstJpg) || fs.existsSync(firstPng);
    const hasLast = fs.existsSync(lastJpg) || fs.existsSync(lastPng);
    if ((mode === "both" || mode === "start_only") && !hasFirst) {
      warnings.push(`${label}: frame_mode=${mode} ama frame_first.(jpg|png) YOK [${kfRoot}]`);
    }
    if ((mode === "both" || mode === "end_only") && !hasLast) {
      warnings.push(`${label}: frame_mode=${mode} ama frame_last.(jpg|png) YOK [${kfRoot}]`);
    }
  }
  return {
    name,
    scene_count: sc.length,
    prompts_ready: s.has_prompts,
    has_video: s.has_video,
    keyframes_source: source,
    scenario,
    warnings: warnings.slice(0, 30),
  };
}
