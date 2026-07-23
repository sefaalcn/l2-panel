import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "./config";

export type SceneRow = Record<string, unknown> & {
  index?: number;
  label?: string;
  frame_mode?: string;
  alternative_scene?: number | string;
};

export function parseAlternativeScene(value: unknown): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1 && n <= 3) return Math.floor(n);
  return 1;
}

/** Studio JSON: geekfree / geek_free — cartoon geek efektleri zorunlu */
export function isGeekFree(scene: SceneRow): boolean {
  const v = scene.geekfree ?? scene.geek_free;
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

export function sceneDescription(scene: SceneRow): string {
  return String(scene.scene_description || "").trim();
}

/** Senaryo A: tüm sahnelerde scene_description dolu */
export function scenesHaveDescriptions(scenes: SceneRow[]): boolean {
  if (!scenes.length) return false;
  return scenes.every((s) => sceneDescription(s).length > 0);
}

/** Gemini gerekli mi? v1 (optimize) + v2 (slow motion) için her koşuda */
export function projectNeedsGemini(scenes: SceneRow[]): boolean {
  return scenes.length > 0;
}

export function sceneMainTopic(scene: SceneRow): string {
  return String(scene.scene_main_topic || "").trim();
}

/**
 * Üretilecek Hailuo varyantları (sahne başına):
 * - v1: Gemini optimize aksiyon (+ geekfree ise tek geek hareketi)
 * - v2: slow motion ana aksiyon
 * - v3: scene_description verbatim (Hailuo optimizer kapalı)
 */
export function productionVariantKeys(scene: SceneRow): string[] {
  const base = ["v1", "v2", "v3"];
  return [...base, ...(isGeekFree(scene) ? ["v4"] : [])];
}

export function productionVariantCount(scene: SceneRow): number {
  return productionVariantKeys(scene).length;
}

export function loadScenesJsonFile(filePath: string): SceneRow[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return (Array.isArray(raw) ? raw : raw.scenes || []) as SceneRow[];
}

/** Studio export — gemini cache vb. yanlışlıkla seçilmesin */
export function isScenesJsonFilename(name: string): boolean {
  if (!name.endsWith(".json")) return false;
  const low = name.toLowerCase();
  if (low.includes("progress") || low.includes("_output")) return false;
  if (low.includes("_gemini") || low.includes("file_cache")) return false;
  return name.includes("_scenes_manual") || name.includes("scenes");
}

export function findScenesJson(projectDir: string): string | null {
  if (!fs.existsSync(projectDir)) return null;
  const cands = fs.readdirSync(projectDir).filter(isScenesJsonFilename);
  const manual = cands.find((n) => n.includes("_scenes_manual"));
  const name = manual || cands[0];
  return name ? path.join(projectDir, name) : null;
}

export function loadProjectScenes(projectName: string): SceneRow[] {
  const file = findScenesJson(path.join(PROJECTS_ROOT, projectName));
  if (!file) return [];
  return loadScenesJsonFile(file);
}

export function sceneVariantKeys(scene: SceneRow, allowedVariants = ["v1", "v2", "v3", "v4"]): string[] {
  const allowed = new Set(allowedVariants.map((v) => v.trim().toLowerCase()).filter(Boolean));
  return productionVariantKeys(scene).filter((k) => allowed.has(k));
}

export type ScenePlanRow = {
  index: number;
  label: string;
  frame_mode: string;
  variants: number;
};

export function buildScenePlan(scenes: SceneRow[]): {
  scenes: ScenePlanRow[];
  variants_summary: string;
  total_videos: number;
} {
  const rows: ScenePlanRow[] = scenes
    .map((s) => {
      const index = Number(s.index ?? 0);
      const variants = productionVariantCount(s);
      return {
        index,
        label: String(s.label || `scene_${String(index).padStart(3, "0")}`),
        frame_mode: String(s.frame_mode || "both"),
        variants,
      };
    })
    .sort((a, b) => a.index - b.index);

  let total = 0;
  let withGeek = 0;
  for (const s of scenes) {
    total += productionVariantCount(s);
    if (isGeekFree(s)) withGeek += 1;
  }
  const parts: string[] = [`${scenes.length} sahne × v1+v2+v3`];
  if (withGeek) parts.push(`${withGeek}×geekfree→v4 (extra)`);

  return {
    scenes: rows,
    variants_summary: parts.length ? parts.join(", ") : "—",
    total_videos: total,
  };
}
