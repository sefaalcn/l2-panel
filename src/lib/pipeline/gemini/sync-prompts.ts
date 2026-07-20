import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import type { KeyframesSource } from "@/lib/ingest";
import {
  findScenesJson,
  isGeekFree,
  loadScenesJsonFile,
  parseAlternativeScene,
  sceneMainTopic,
  type SceneRow,
} from "@/lib/scenes";
import { genGeekAddon, genAltV1, uploadOrCache } from "./client";
import { loadCharRefs, loadSwapFlag } from "./frames";
import type { SceneRow as GeminiSceneRow } from "./project";
import {
  buildVideoContext,
  log,
  parseScenesFilter,
  readTextFileIfExists,
  setupProject,
} from "./project";

export type SyncPromptsOptions = {
  projectPath: string;
  keyframesSource: KeyframesSource;
  scenesFilter?: string | null;
  apiKey: string;
};

function toGeminiScene(s: SceneRow): GeminiSceneRow {
  return { ...s, index: Number(s.index ?? 0) };
}

function sceneDescription(scene: SceneRow): string {
  return String(scene.scene_description || "").trim();
}

/** Senaryo A: v1 = scene_description; Gemini yalnız v2 (alt≥2) ve geek (geekfree) için */
export async function syncPromptsFromScenes(opts: SyncPromptsOptions): Promise<number> {
  const paths = setupProject(opts.projectPath, opts.keyframesSource);
  const scenesFile = findScenesJson(opts.projectPath);
  if (!scenesFile) {
    log("❌ scenes JSON bulunamadı");
    return 1;
  }

  const allScenes = loadScenesJsonFile(scenesFile);
  const { lo, hi } = parseScenesFilter(opts.scenesFilter);
  const scenes = allScenes.filter((s) => Number(s.index ?? 0) >= lo && Number(s.index ?? 0) <= hi);

  const missing = scenes.filter((s) => !sceneDescription(s));
  if (missing.length) {
    log(`❌ ${missing.length} sahne scene_description içermiyor — Senaryo B (video+Gemini) gerekir`);
    return 1;
  }

  log("=".repeat(60));
  log(`SENARYO A — scene_description → v1 | sahne ${lo}-${hi} (${scenes.length})`);
  log("=".repeat(60));

  fs.mkdirSync(paths.outputDir, { recursive: true });

  const existing: Record<number, Record<string, unknown>> = {};
  if (fs.existsSync(paths.promptsJson)) {
    try {
      const cur = JSON.parse(fs.readFileSync(paths.promptsJson, "utf8"));
      const arr = Array.isArray(cur) ? cur : cur.scenes || [];
      for (const p of arr) {
        if (p && typeof p.index === "number") existing[p.index] = p;
      }
    } catch {
      /* */
    }
  }

  const metaByIdx: Record<number, SceneRow> = {};
  for (const s of allScenes) metaByIdx[Number(s.index ?? 0)] = s;

  for (const s of scenes) {
    const idx = Number(s.index ?? 0);
    const desc = sceneDescription(s);
    const prev = existing[idx] || {};
    existing[idx] = {
      ...prev,
      index: idx,
      label: String(s.label || `scene_${String(idx).padStart(3, "0")}`),
      frame_mode: String(s.frame_mode || "both"),
      scene_desc: desc,
      scene_type: "manual",
      v1: desc,
      v2: parseAlternativeScene(s.alternative_scene) >= 2 ? prev.v2 || "" : "",
      geek: isGeekFree(s) ? prev.geek || "" : "",
      v3: "",
      alternative_scene: s.alternative_scene,
      geekfree: isGeekFree(s),
      video_duration: s.video_duration,
      video_model: s.video_model,
      source: "scene_description",
    };
    log(`   📝 ${String(idx).padStart(3, "0")} v1 ← scene_description`);
  }

  const needAlt = scenes.filter((s) => parseAlternativeScene(s.alternative_scene) >= 2);
  const needGeek = scenes.filter(isGeekFree);
  const needGemini = needAlt.length > 0 || needGeek.length > 0;

  if (needGemini) {
    if (!opts.apiKey?.trim()) {
      log("❌ GEMINI_API_KEY gerekli (alternative_scene≥2 veya geekfree sahneler var)");
      return 1;
    }

    const videoContext = buildVideoContext(paths);
    const swapOn = loadSwapFlag(paths);
    const charRefs = swapOn ? await loadCharRefs(paths) : [];
    const client = new GoogleGenAI({ apiKey: opts.apiKey });
    const vid = await uploadOrCache(client, paths);

    for (const s of needAlt) {
      const idx = Number(s.index ?? 0);
      const base = sceneDescription(s);
      log(`\n── ALT v2 (ek v1): sahne ${idx} ──`);
      try {
        const v2 = await genAltV1(client, vid, toGeminiScene(s), paths, videoContext, charRefs, swapOn, base);
        if (v2) {
          existing[idx].v2 = v2;
          existing[idx].source = "scene_description+gemini_alt";
          log(`   ✅ v2 üretildi (${v2.length} karakter)`);
        } else {
          log("   ⚠️ v2 boş — atlandı");
        }
      } catch (e) {
        log(`   ❌ v2 hatası: ${e}`);
      }
      await sleep(3000);
    }

    for (const s of needGeek) {
      const idx = Number(s.index ?? 0);
      const base = sceneDescription(s);
      const topic = sceneMainTopic(s);
      log(`\n── GEEKFREE: sahne ${idx} (yalnız bu kesit) ──`);
      try {
        const geek = await genGeekAddon(client, vid, toGeminiScene(s), paths, videoContext, charRefs, swapOn, base, topic);
        if (geek) {
          existing[idx].geek = geek;
          existing[idx].v3 = `${base} ${geek}`.trim();
          existing[idx].source = "scene_description+gemini_geek";
          log(`   ✅ geek üretildi → v3 = v1 + geek`);
        } else {
          log("   ⚠️ geek boş — atlandı");
        }
      } catch (e) {
        log(`   ❌ geek hatası: ${e}`);
      }
      await sleep(3000);
    }
  }

  const out = Object.values(existing)
    .filter((p) => (p.index as number) >= lo && (p.index as number) <= hi)
    .sort((a, b) => (a.index as number) - (b.index as number));

  fs.writeFileSync(paths.promptsJson, JSON.stringify(out, null, 2), "utf8");

  const review = [
    `SENARYO A — scene ${lo}-${hi}`,
    "=".repeat(50),
    ...out.flatMap((p) => [
      `\n--- Scene ${String(p.index).padStart(3, "0")}${p.geekfree ? " GEEKFREE" : ""} ---`,
      `V1 (scene_description): ${p.v1}`,
      ...(p.v2 ? [`V2 (alt v1): ${p.v2}`] : []),
      ...(p.geek ? [`GEEK: ${p.geek}`, `V3 (v1+geek): ${p.v3}`] : []),
    ]),
  ];
  fs.writeFileSync(path.join(paths.outputDir, "gemini_direct_review.txt"), review.join("\n"), "utf8");

  log(`\n✅ TAMAM — ${out.length} sahne → ${paths.promptsJson}`);
  return 0;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
