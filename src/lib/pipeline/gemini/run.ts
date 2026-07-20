import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import type { KeyframesSource } from "@/lib/ingest";
import { genBatch, selfCheck, clip, normalizeChar, MAX_V1, MAX_V2, MAX_V3, uploadOrCache } from "./client";
import { loadCharRefs, loadSwapFlag } from "./frames";
import {
  buildVideoContext,
  loadScenes,
  log,
  parseScenesFilter,
  readTextFileIfExists,
  setupProject,
} from "./project";

export type GeminiRunOptions = {
  projectPath: string;
  keyframesSource: KeyframesSource;
  scenesFilter?: string | null;
  apiKey: string;
};

const SELF_CHECK = true;

export async function generatePrompts(opts: GeminiRunOptions): Promise<number> {
  if (!opts.apiKey?.trim()) {
    log('❌ GEMINI_API_KEY gerekli');
    return 1;
  }

  const paths = setupProject(opts.projectPath, opts.keyframesSource);
  const videoContext = buildVideoContext(paths);
  const swapOn = loadSwapFlag(paths);
  const charRefs = swapOn ? await loadCharRefs(paths) : [];
  const videoChars = readTextFileIfExists(paths.charsFile);

  const allScenes = loadScenes(paths.scenesJson);
  const { lo, hi } = parseScenesFilter(opts.scenesFilter);
  const scenes = allScenes.filter((s) => s.index >= lo && s.index <= hi);

  log("=".repeat(60));
  log(`GEMINI DIRECT (TS) — optimizer-dostu v1/v2/v3 | sahne ${lo}-${hi} (${scenes.length})`);
  log("=".repeat(60));

  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const vid = await uploadOrCache(client, paths);

  fs.mkdirSync(paths.outputDir, { recursive: true });

  const existing: Record<number, Record<string, unknown>> = {};
  if (fs.existsSync(paths.promptsJson)) {
    const cur = JSON.parse(fs.readFileSync(paths.promptsJson, "utf8"));
    const arr = Array.isArray(cur) ? cur : cur.scenes || [];
    for (const p of arr) {
      if (p && typeof p.index === "number") existing[p.index] = p;
    }
    log(`📄 Mevcut prompts: ${Object.keys(existing).length} sahne (korunacak)`);
  }

  const labelByIdx: Record<number, string> = {};
  const fmByIdx: Record<number, string> = {};
  const descByIdx: Record<number, string> = {};
  const vdurByIdx: Record<number, unknown> = {};
  const vmodelByIdx: Record<number, unknown> = {};
  const altByIdx: Record<number, unknown> = {};

  for (const s of allScenes) {
    labelByIdx[s.index] = String(s.label || `scene_${String(s.index).padStart(3, "0")}`);
    fmByIdx[s.index] = String(s.frame_mode || "both");
    descByIdx[s.index] = normalizeChar(String(s.scene_description || "").trim());
    vdurByIdx[s.index] = s.video_duration;
    vmodelByIdx[s.index] = s.video_model;
    altByIdx[s.index] = s.alternative_scene;
  }

  const overlayCues: Record<string, unknown>[] = [];
  let overlayPrev: Record<string, unknown>[] = [];
  if (fs.existsSync(paths.overlayJson)) {
    try {
      const prev = JSON.parse(fs.readFileSync(paths.overlayJson, "utf8"));
      if (Array.isArray(prev)) {
        overlayPrev = prev.filter(
          (c) =>
            typeof c === "object" &&
            c &&
            !((c as { scene_index?: number }).scene_index! >= lo &&
              (c as { scene_index?: number }).scene_index! <= hi),
        );
      }
    } catch {
      log("⚠️ overlay_cues.json okunamadı");
    }
  }

  const BATCH = 1;
  for (let i = 0; i < scenes.length; i += BATCH) {
    const batch = scenes.slice(i, i + BATCH);
    log(`\n── Batch ${Math.floor(i / BATCH) + 1}: ${batch.map((s) => s.index).join(",")} ──`);
    let res: Record<string, unknown>[] | null = null;
    try {
      res = await genBatch(client, vid, batch, paths, videoContext, charRefs, swapOn);
    } catch (e) {
      log(`   ❌ API hatası: ${e}`);
    }
    if (!res) {
      log("   ⚠️ boş yanıt, batch atlandı");
      continue;
    }

    const rmap: Record<number, Record<string, unknown>> = {};
    for (const r of res) {
      if (r && "scene_index" in r) {
        const idx = Number(r.scene_index);
        if (!Number.isNaN(idx)) rmap[idx] = r;
      }
    }

    for (let pos = 0; pos < batch.length; pos++) {
      const s = batch[pos];
      const idx = s.index;
      let r = rmap[idx];
      if (!r && res.length === batch.length) r = res[pos];
      if (!r || !r.v1) {
        log(`   ⚠️ ${String(idx).padStart(3, "0")} eşleşme yok / boş v1`);
        continue;
      }

      let faceVis = r.face_visible ?? true;
      if (typeof faceVis === "string") {
        faceVis = !["false", "no", "0"].includes(faceVis.trim().toLowerCase());
      }

      const entry: Record<string, unknown> = {
        index: idx,
        label: labelByIdx[idx],
        frame_mode: fmByIdx[idx],
        scene_desc: descByIdx[idx],
        scene_type: "manual",
        v1: clip(normalizeChar(String(r.v1 || "")), MAX_V1, true, Boolean(faceVis)),
        v2: clip(normalizeChar(String(r.v2 || "")), MAX_V2, false, Boolean(faceVis)),
        v3: clip(normalizeChar(String(r.v3 || "")), MAX_V3, true, Boolean(faceVis)),
        emotion: r.emotion || "",
        face_visible: faceVis,
        source: "gemini_direct_ts",
        video_duration: vdurByIdx[idx],
        video_model: vmodelByIdx[idx],
        alternative_scene: altByIdx[idx],
      };

      if (SELF_CHECK) {
        const checked = await selfCheck(client, entry, Boolean(faceVis), videoChars);
        const fv2 = checked.entry.face_visible;
        checked.entry.v1 = clip(
          normalizeChar(String(checked.entry.v1 || "")),
          MAX_V1,
          true,
          Boolean(fv2),
        );
        checked.entry.v2 = clip(
          normalizeChar(String(checked.entry.v2 || "")),
          MAX_V2,
          false,
          Boolean(fv2),
        );
        checked.entry.v3 = clip(
          normalizeChar(String(checked.entry.v3 || "")),
          MAX_V3,
          true,
          Boolean(fv2),
        );
        Object.assign(entry, checked.entry);
        if (checked.changed.length) {
          log(`      ✏️ self-check düzeltti: ${checked.changed.join(", ")}`);
        } else {
          log("      ✓ self-check: temiz");
        }
      }

      existing[idx] = entry;
      const ov = r.fx_overlay;
      if (ov && ov !== "none" && typeof ov === "object") {
        overlayCues.push({
          ...(ov as object),
          scene_index: idx,
          scene_label: labelByIdx[idx],
        });
      }
      log(`   ✅ ${String(idx).padStart(3, "0")} [${entry.emotion}]`);
    }

    const out = Object.values(existing).sort(
      (a, b) => (a.index as number) - (b.index as number),
    );
    fs.writeFileSync(paths.promptsJson, JSON.stringify(out, null, 2), "utf8");
    if (i + BATCH < scenes.length) await new Promise((r) => setTimeout(r, 3000));
  }

  const out = Object.values(existing).sort((a, b) => (a.index as number) - (b.index as number));
  fs.writeFileSync(paths.promptsJson, JSON.stringify(out, null, 2), "utf8");
  const overlayAll = [...overlayPrev, ...overlayCues].sort(
    (a, b) => (a.scene_index as number) - (b.scene_index as number),
  );
  if (overlayAll.length || fs.existsSync(paths.overlayJson)) {
    fs.writeFileSync(paths.overlayJson, JSON.stringify(overlayAll, null, 2), "utf8");
  }

  const review = [
    `GEMINI DIRECT (TS) — scene ${lo}-${hi}`,
    "=".repeat(50),
    ...out
      .filter((p) => (p.index as number) >= lo && (p.index as number) <= hi)
      .flatMap((p) => [
        `\n--- Scene ${String(p.index).padStart(3, "0")} [${p.frame_mode}] ---`,
        `V1: ${p.v1}`,
        `V2: ${p.v2}`,
        `V3: ${p.v3}`,
      ]),
  ];
  fs.writeFileSync(path.join(paths.outputDir, "gemini_direct_review.txt"), review.join("\n"), "utf8");

  log(`\n✅ TAMAM — ${lo}-${hi} güncellendi (toplam ${out.length} sahne)`);
  log(`📄 ${paths.promptsJson}`);
  return 0;
}
