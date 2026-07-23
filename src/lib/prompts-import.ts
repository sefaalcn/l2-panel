import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "./config";
import { isGeekFree, loadProjectScenes, type SceneRow } from "./scenes";
import { resolveRouterPaths } from "./pipeline/router/resolve";

export type ImportedPrompt = Record<string, unknown> & {
  index: number;
  v1: string;
};

function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.scenes)) return o.scenes;
    if (Array.isArray(o.prompts)) return o.prompts;
  }
  return [];
}

function pickPromptText(row: Record<string, unknown>): string {
  for (const key of ["v1", "prompt", "prompt_v1", "text", "hailuo_prompt"]) {
    const v = String(row[key] || "").trim();
    if (v) return v;
  }
  return "";
}

/** Gemini / panel çıktısı JSON → runner formatı + scenes JSON ile zenginleştir */
export function normalizePromptsJson(
  raw: unknown,
  projectScenes: SceneRow[],
): { prompts: ImportedPrompt[]; errors: string[] } {
  const errors: string[] = [];
  const rows = asArray(raw);
  if (!rows.length) {
    return { prompts: [], errors: ["JSON boş veya scenes/prompts dizisi yok"] };
  }

  const byIdx = new Map<number, SceneRow>();
  for (const s of projectScenes) {
    byIdx.set(Number(s.index ?? 0), s);
  }

  const out: ImportedPrompt[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") {
      errors.push(`satır ${i + 1}: nesne değil`);
      continue;
    }
    const r = row as Record<string, unknown>;
    const idx = Number(r.index ?? r.scene_index ?? r.sceneIndex);
    if (!Number.isFinite(idx) || idx <= 0) {
      errors.push(`satır ${i + 1}: index yok`);
      continue;
    }
    const v1 = pickPromptText(r);
    if (!v1) {
      errors.push(`scene_${String(idx).padStart(3, "0")}: v1/prompt boş`);
      continue;
    }

    const scene = byIdx.get(idx);
    const label =
      String(r.label || scene?.label || `scene_${String(idx).padStart(3, "0")}`).trim() ||
      `scene_${String(idx).padStart(3, "0")}`;
    const entry: ImportedPrompt = {
      ...r,
      index: idx,
      label,
      frame_mode: String(r.frame_mode || scene?.frame_mode || "both"),
      scene_desc: String(
        r.scene_desc || r.scene_description || scene?.scene_description || "",
      ).trim(),
      v1,
      v2: String(r.v2 || r.prompt_v2 || "").trim(),
      v3: String(r.v3 || r.prompt_v3 || "").trim(),
      source: String(r.source || "imported_json"),
    };
    if (r.v4 != null && String(r.v4).trim()) entry.v4 = String(r.v4).trim();
    if (r.emotion != null) entry.emotion = r.emotion;
    if (r.face_visible != null) entry.face_visible = r.face_visible;
    if (r.video_duration != null || scene?.video_duration != null) {
      entry.video_duration = r.video_duration ?? scene?.video_duration;
    }
    if (r.video_model != null || scene?.video_model != null) {
      entry.video_model = r.video_model ?? scene?.video_model;
    }
    if (r.alternative_scene != null || scene?.alternative_scene != null) {
      entry.alternative_scene = r.alternative_scene ?? scene?.alternative_scene;
    }
    if (r.geekfree != null || (scene && isGeekFree(scene))) {
      entry.geekfree = r.geekfree != null ? r.geekfree : true;
    }
    out.push(entry);
  }

  out.sort((a, b) => a.index - b.index);
  return { prompts: out, errors };
}

export function writeProjectPrompts(
  projectName: string,
  raw: unknown,
): {
  ok: boolean;
  path?: string;
  count?: number;
  withV1?: number;
  errors?: string[];
  detail?: string;
} {
  const proj = path.join(PROJECTS_ROOT, projectName);
  if (!fs.existsSync(proj)) {
    return { ok: false, detail: `Proje yok: ${projectName}` };
  }

  let projectScenes: SceneRow[] = [];
  try {
    projectScenes = loadProjectScenes(projectName);
  } catch {
    projectScenes = [];
  }

  const { prompts, errors } = normalizePromptsJson(raw, projectScenes);
  if (!prompts.length) {
    return {
      ok: false,
      detail: errors[0] || "Geçerli prompt satırı yok (index + v1 gerekli)",
      errors,
    };
  }

  const promptsJson = resolveRouterPaths("hailuo", proj).promptsJson;
  fs.mkdirSync(path.dirname(promptsJson), { recursive: true });
  fs.writeFileSync(promptsJson, JSON.stringify(prompts, null, 2), "utf8");

  return {
    ok: true,
    path: promptsJson,
    count: prompts.length,
    withV1: prompts.filter((p) => String(p.v1 || "").trim()).length,
    errors: errors.length ? errors.slice(0, 12) : undefined,
  };
}
