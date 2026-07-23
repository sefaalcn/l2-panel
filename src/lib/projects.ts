import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "./config";
import {
  keyframesDirName,
  parseKeyframesSource,
  readKeyframesSource,
  type KeyframesSource,
} from "./ingest";
import {
  hasSceneDirs,
  resolveKeyframesLeaf,
} from "./pipeline/router/resolve";
import {
  buildScenePlan,
  findScenesJson,
  loadScenesJsonFile,
  projectNeedsGemini,
  scenesHaveDescriptions,
  type SceneRow,
} from "./scenes";
import {
  normalizeVideoModel,
  projectHasFireflyScenes,
  projectHasHailuoScenes,
  sceneUsesFirefly,
  sceneUsesHailuo,
} from "./video-model";

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

export function projectSummary(name: string): ProjectSummary {
  const dir = path.join(PROJECTS_ROOT, name);
  const scenesPath = findScenesJson(dir);
  const scenesName = scenesPath ? path.basename(scenesPath) : null;
  const kf = path.join(dir, "keyframes");
  const kfSwap = path.join(dir, "keyframes_swapped");
  const prompts = path.join(dir, `${name}_output`, "hailuo_prompts_claude.json");
  let sceneCount: number | null = null;
  let version: number | string | null = null;
  if (scenesPath) {
    try {
      const sc = loadScenesJsonFile(scenesPath);
      sceneCount = sc.length;
      const raw = JSON.parse(fs.readFileSync(scenesPath, "utf8"));
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
  const kfPreferred = path.join(dir, kfRoot);
  const kfExists = fs.existsSync(kfPreferred);
  const kfDir = kfExists ? resolveKeyframesLeaf(kfPreferred) : kfPreferred;
  const hasActiveKf =
    kfExists && (hasSceneDirs(kfDir) || dirHasFiles(kfDir));

  const scenesPath = findScenesJson(dir);
  if (!scenesPath) {
    return {
      name,
      scene_count: null,
      warnings: ["kaynak scenes JSON yok"],
      prompts_ready: s.has_prompts,
      has_video: s.has_video,
      keyframes_source: source,
      scenario: "B-eksik" as const,
      scene_plan: [],
      variants_summary: "—",
      total_videos: 0,
    };
  }
  const scenes = loadScenesJsonFile(scenesPath);
  const warnings: string[] = [];
  if (!kfExists) {
    warnings.push(
      source === "swapped"
        ? "keyframes_swapped/ yok — Swapped ZIP yükle veya Orijinal seç (sessizce orijinale düşülmez)"
        : "keyframes/ yok — Orijinal keyframes ZIP yükle",
    );
  } else if (!hasActiveKf) {
    warnings.push(
      `${kfRoot}/ boş — keyframes ZIP yükle (kaynak: ${source})`,
    );
  }
  let scenario: "A" | "B" | "B-eksik";
  const hasDescriptions = scenesHaveDescriptions(scenes);
  if (hasDescriptions) {
    scenario = "A";
    if (projectNeedsGemini(scenes)) {
      warnings.push("Gemini: v1 (optimize) + v2 (slow motion); v3 = scene_description verbatim; v4 = geekfree extra");
    }
  } else if (s.has_video) {
    scenario = "B";
    warnings.push("scene_description eksik → Gemini videodan prompt üretecek");
  } else {
    scenario = "B-eksik";
    warnings.push("scene_description ve kaynak video yok → üretilemez");
  }
  for (const scene of scenes as SceneRow[]) {
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
  const plan = buildScenePlan(scenes);
  const fireflyScenes = scenes.filter(sceneUsesFirefly);
  const hailuoScenes = scenes.filter(sceneUsesHailuo);
  return {
    name,
    scene_count: scenes.length,
    prompts_ready: hasDescriptions,
    needs_gemini: projectNeedsGemini(scenes),
    has_firefly_scenes: projectHasFireflyScenes(scenes),
    has_hailuo_scenes: projectHasHailuoScenes(scenes),
    hailuo_scene_count: hailuoScenes.length,
    firefly_scene_count: fireflyScenes.length,
    firefly_models: [
      ...new Set(
        fireflyScenes.map((s) => normalizeVideoModel(s.video_model)).filter(Boolean),
      ),
    ],
    has_video: s.has_video,
    keyframes_source: source,
    scenario,
    warnings: warnings.slice(0, 30),
    scene_plan: plan.scenes,
    variants_summary: plan.variants_summary,
    total_videos: plan.total_videos,
  };
}
