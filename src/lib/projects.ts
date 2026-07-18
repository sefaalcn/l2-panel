import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "./config";

export type ProjectSummary = {
  name: string;
  has_scenes_json: boolean;
  scenes_json: string | null;
  version: number | string | null;
  has_keyframes: boolean;
  has_prompts: boolean;
  has_video: boolean;
  scene_count: number | null;
};

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
  return {
    name,
    has_scenes_json: Boolean(scenesName),
    scenes_json: scenesName,
    version,
    has_keyframes: fs.existsSync(kf) && fs.readdirSync(kf).length > 0,
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
    .filter((s) => s.has_scenes_json || s.has_keyframes || s.has_video)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function preflight(name: string) {
  const dir = path.join(PROJECTS_ROOT, name);
  if (!fs.existsSync(dir)) return null;
  const s = projectSummary(name);
  const scenesName = s.scenes_json;
  if (!scenesName) {
    return {
      name,
      scene_count: null,
      warnings: ["kaynak scenes JSON yok"],
      prompts_ready: s.has_prompts,
      has_video: s.has_video,
      scenario: "B-eksik" as const,
    };
  }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, scenesName), "utf8"));
  const sc: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw.scenes || [];
  const warnings: string[] = [];
  if (!s.has_keyframes) warnings.push("keyframes/ boş veya yok — Studio keyframes.zip gerekli");
  let scenario: "A" | "B" | "B-eksik";
  if (s.has_prompts) scenario = "A";
  else if (s.has_video) {
    scenario = "B";
    warnings.push("prompt YOK → gemini_direct üretecek (kaynak video ✓)");
  } else {
    scenario = "B-eksik";
    warnings.push("prompt YOK ve kaynak video (.mp4) YOK → prompt üretilemez");
  }
  // basit frame_mode dosya kontrolü
  for (const scene of sc) {
    const mode = String(scene.frame_mode || "both");
    const label = String(scene.label || `scene_${String(scene.index || 0).padStart(3, "0")}`);
    const first = path.join(dir, "keyframes", label, "frame_first.jpg");
    const last = path.join(dir, "keyframes", label, "frame_last.jpg");
    if ((mode === "both" || mode === "start_only") && !fs.existsSync(first)) {
      warnings.push(`${label}: frame_mode=${mode} ama frame_first.jpg YOK`);
    }
    if ((mode === "both" || mode === "end_only") && !fs.existsSync(last)) {
      warnings.push(`${label}: frame_mode=${mode} ama frame_last.jpg YOK`);
    }
  }
  return {
    name,
    scene_count: sc.length,
    prompts_ready: s.has_prompts,
    has_video: s.has_video,
    scenario,
    warnings: warnings.slice(0, 30),
  };
}
