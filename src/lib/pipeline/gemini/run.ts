import fs from "fs";
import path from "path";
import type { KeyframesSource } from "@/lib/ingest";
import { isGeekFree, parseAlternativeScene } from "@/lib/scenes";
import {
  formatFailLessonsForGemini,
  loadFailLessonsFromBase,
} from "@/lib/fail-lessons";
import {
  formatLearnedRulesForGemini,
  loadLearnedRulesFromBase,
} from "@/lib/learned-rules";
import { genBatch, selfCheck, clip, normalizeChar, MAX_V1, MAX_V2, MAX_V3, uploadOrCache } from "./client";
import {
  createGeminiClient,
  formatGeminiQuotaHint,
  isFreeTierQuotaError,
} from "./ai-client";
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
  /** Senaryo A: v3 = scene_description verbatim; geekfree → v1'e birleştir */
  useSceneDescAsV3?: boolean;
  /** true → mevcut promptları yok sayıp tüm sahneleri baştan üret */
  forceRegenerate?: boolean;
};

const SELF_CHECK = true;

function hasUsablePrompt(entry: Record<string, unknown> | undefined): boolean {
  return Boolean(String(entry?.v1 || "").trim());
}

function hasUsableV4(entry: Record<string, unknown> | undefined): boolean {
  return Boolean(String(entry?.v4 || "").trim());
}

export async function generatePrompts(opts: GeminiRunOptions): Promise<number> {
  const paths = setupProject(opts.projectPath, opts.keyframesSource);
  const videoContext = buildVideoContext(paths);
  const learnedRaw = loadLearnedRulesFromBase(paths.base);
  const learnedBlock = formatLearnedRulesForGemini(learnedRaw);
  if (learnedBlock) {
    log(`📘 Learned rules yüklendi (yalnız Gemini yazımına — Hailuo/Firefly prompt'una eklenmez)`);
  }
  const failData = loadFailLessonsFromBase(paths.base);
  const failLessons = [learnedBlock, formatFailLessonsForGemini(failData)]
    .filter(Boolean)
    .join("\n\n");
  if (failData.items.length) {
    log(`📚 Fail lessons: ${failData.items.length} işaretli kötü çıktı Gemini'ye yüklendi`);
  }
  const swapOn = loadSwapFlag(paths);
  const charRefs = swapOn ? await loadCharRefs(paths) : [];
  const videoChars = readTextFileIfExists(paths.charsFile);

  const allScenes = loadScenes(paths.scenesJson);
  const { lo, hi } = parseScenesFilter(opts.scenesFilter);
  const scenes = allScenes.filter((s) => s.index >= lo && s.index <= hi);

  log("=".repeat(60));
  log(
    `GEMINI DIRECT (TS) — v1 ana · v2 slow · v3${opts.useSceneDescAsV3 ? " orijinal" : " gag"} | sahne ${lo}-${hi} (${scenes.length})${opts.forceRegenerate ? " | YENİDEN ÜRET" : ""}`,
  );
  log("=".repeat(60));

  fs.mkdirSync(paths.outputDir, { recursive: true });

  const existing: Record<number, Record<string, unknown>> = {};
  if (fs.existsSync(paths.promptsJson) && !opts.forceRegenerate) {
    const cur = JSON.parse(fs.readFileSync(paths.promptsJson, "utf8"));
    const arr = Array.isArray(cur) ? cur : cur.scenes || [];
    for (const p of arr) {
      if (p && typeof p.index === "number") existing[p.index] = p;
    }
    log(`📄 Mevcut prompts: ${Object.keys(existing).length} sahne (korunacak)`);
  } else if (opts.forceRegenerate && fs.existsSync(paths.promptsJson)) {
    // Aralık dışındaki sahneleri koru; filtre içini baştan yaz
    try {
      const cur = JSON.parse(fs.readFileSync(paths.promptsJson, "utf8"));
      const arr = Array.isArray(cur) ? cur : cur.scenes || [];
      for (const p of arr) {
        if (p && typeof p.index === "number") {
          const idx = p.index as number;
          if (idx < lo || idx > hi) existing[idx] = p;
        }
      }
      log(`🔄 Yeniden üretim: ${lo}-${hi} silinecek, diğerleri korunacak (${Object.keys(existing).length})`);
    } catch {
      log("🔄 Yeniden üretim: mevcut prompts okunamadı, sıfırdan");
    }
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

  const geekCount = scenes.filter(isGeekFree).length;
  if (geekCount) log(`🎭 GEEKFREE sahneler: ${geekCount} (tek-sahne cartoon geek geçişi)`);

  // Varsayılan: v1'i olanları atla. Yeniden üret: hepsini yaz.
  const normalScenes = opts.forceRegenerate
    ? scenes
    : scenes.filter((s) => !hasUsablePrompt(existing[s.index]));
  const geekScenes = opts.forceRegenerate
    ? scenes.filter(isGeekFree)
    : scenes.filter(isGeekFree).filter((s) => !hasUsableV4(existing[s.index]));
  const skippedNormal = scenes.length - normalScenes.length;
  if (skippedNormal) {
    log(`⏭️ Prompt’u hazır ${skippedNormal} sahne atlandı (yeniden yazılmayacak)`);
  }
  if (normalScenes.length) {
    log(`📝 Üretilecek: ${normalScenes.length} sahne → ${normalScenes.map((s) => s.index).join(",")}`);
  } else {
    log("📝 Üretilecek normal sahne yok");
  }

  // Hepsi hazır → Gemini video upload / API yok, doğrudan video fazına
  if (!normalScenes.length && !geekScenes.length) {
    log("⏭️ Tüm promptlar hazır — Gemini atlandı, video üretimine geçiliyor");
    return 0;
  }

  if (!opts.apiKey?.trim()) {
    log("❌ GEMINI_API_KEY gerekli (eksik prompt var)");
    return 1;
  }

  const client = createGeminiClient(opts.apiKey);
  log(
    "🔑 Gemini: Developer API (apiKey). Free/Paid ayrımı key'in AI Studio projesine bağlı — billing'li PAID projeden key kullan.",
  );
  const vid = await uploadOrCache(client, paths);

  async function applyBatch(batch: typeof scenes, res: Record<string, unknown>[] | null) {
    if (!res) return false;

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
        source: isGeekFree(s) ? "gemini_geekfree_ts" : "gemini_direct_ts",
        video_duration: vdurByIdx[idx],
        video_model: vmodelByIdx[idx],
        alternative_scene: altByIdx[idx],
        geekfree: isGeekFree(s),
      };

      let v3Translation = "";
      if (opts.useSceneDescAsV3) {
        v3Translation = normalizeChar(String(r.v3 || "")).trim() || descByIdx[idx];
        entry.v3 = v3Translation;
        entry.source = isGeekFree(s) ? "scene_description+gemini_geek_v1" : "scene_description+gemini";
      } else {
        const alt = parseAlternativeScene(altByIdx[idx] ?? s.alternative_scene);
        if (alt < 2) entry.v2 = "";
        if (alt < 3) entry.v3 = "";
      }

      if (SELF_CHECK) {
        const checked = await selfCheck(client, entry, Boolean(faceVis), videoChars, failLessons);
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
        checked.entry.v3 = opts.useSceneDescAsV3
          ? v3Translation
          : clip(
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
      log(`   ✅ ${String(idx).padStart(3, "0")} [${entry.emotion}]${isGeekFree(s) ? " 🎭 geek" : ""}`);
    }
    return true;
  }

  async function applyGeekBatch(
    batch: typeof scenes,
    res: Record<string, unknown>[] | null,
  ) {
    if (!res) return false;

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
        log(`   ⚠️ ${String(idx).padStart(3, "0")} geek v1 eşleşme yok / boş`);
        continue;
      }

      let faceVis = r.face_visible ?? true;
      if (typeof faceVis === "string") {
        faceVis = !["false", "no", "0"].includes(faceVis.trim().toLowerCase());
      }

      let v3Translation = "";
      const entryForCheck: Record<string, unknown> = {
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
        source: "gemini_geekfree_ts",
        video_duration: vdurByIdx[idx],
        video_model: vmodelByIdx[idx],
        alternative_scene: altByIdx[idx],
        geekfree: true,
      };

      if (opts.useSceneDescAsV3) {
        v3Translation = normalizeChar(String(r.v3 || "")).trim() || descByIdx[idx];
        entryForCheck.v3 = v3Translation;
      } else {
        const alt = parseAlternativeScene(altByIdx[idx] ?? s.alternative_scene);
        if (alt < 2) entryForCheck.v2 = "";
        if (alt < 3) entryForCheck.v3 = "";
      }

      let v4Prompt = String(entryForCheck.v1 || "");
      if (SELF_CHECK) {
        const checked = await selfCheck(
          client,
          entryForCheck,
          Boolean(faceVis),
          videoChars,
          failLessons,
        );
        const fv2 = checked.entry.face_visible;
        checked.entry.v1 = clip(
          normalizeChar(String(checked.entry.v1 || "")),
          MAX_V1,
          true,
          Boolean(fv2),
        );
        v4Prompt = String(checked.entry.v1 || "");
      }

      existing[idx] = { ...(existing[idx] || {}), v4: v4Prompt, geekfree: true };
      log(`   ✅ ${String(idx).padStart(3, "0")} geek -> v4 hazır`);
    }

    return true;
  }

  function abortIfFreeTier(err: unknown): boolean {
    if (!isFreeTierQuotaError(err)) return false;
    log(`\n🛑 ${formatGeminiQuotaHint(err)}`);
    log("   Duruyorum — free tier'da 3.1 Pro limiti 0; AI Studio PAID projeden yeni key alıp yeniden başlat.");
    return true;
  }

  const BATCH = 1;
  let stoppedForQuota = false;
  for (let i = 0; i < normalScenes.length; i += BATCH) {
    const batch = normalScenes.slice(i, i + BATCH);
    log(
      `\n── Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(normalScenes.length / BATCH) || 1}: ${batch.map((s) => s.index).join(",")} ──`,
    );
    let res: Record<string, unknown>[] | null = null;
    try {
      res = await genBatch(
        client,
        vid,
        batch,
        paths,
        videoContext,
        charRefs,
        swapOn,
        false,
        Boolean(opts.useSceneDescAsV3),
      );
    } catch (e) {
      log(`   ❌ API hatası: ${e}`);
      if (abortIfFreeTier(e)) {
        stoppedForQuota = true;
        break;
      }
    }
    if (!(await applyBatch(batch, res))) {
      log("   ⚠️ boş yanıt, batch atlandı");
    }

    const outMid = Object.values(existing).sort(
      (a, b) => (a.index as number) - (b.index as number),
    );
    fs.writeFileSync(paths.promptsJson, JSON.stringify(outMid, null, 2), "utf8");
    if (i + BATCH < normalScenes.length) await new Promise((r) => setTimeout(r, 3000));
  }

  if (!stoppedForQuota) {
    for (let i = 0; i < geekScenes.length; i++) {
      const batch = [geekScenes[i]];
      log(
        `\n── GEEKFREE ${Math.floor(i) + 1}/${geekScenes.length}: sahne ${batch[0].index} (yalnız bu kesit) ──`,
      );
      let res: Record<string, unknown>[] | null = null;
      try {
        res = await genBatch(
          client,
          vid,
          batch,
          paths,
          videoContext,
          charRefs,
          swapOn,
          true,
          Boolean(opts.useSceneDescAsV3),
        );
      } catch (e) {
        log(`   ❌ GEEKFREE API hatası: ${e}`);
        if (abortIfFreeTier(e)) break;
      }
      if (!(await applyGeekBatch(batch, res))) {
        log("   ⚠️ GEEKFREE boş yanıt, sahne atlandı");
      }

      const outMid = Object.values(existing).sort(
        (a, b) => (a.index as number) - (b.index as number),
      );
      fs.writeFileSync(paths.promptsJson, JSON.stringify(outMid, null, 2), "utf8");
      if (i + 1 < geekScenes.length) await new Promise((r) => setTimeout(r, 3000));
    }
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
        `\n--- Scene ${String(p.index).padStart(3, "0")} [${p.frame_mode}]${p.geekfree ? " GEEKFREE" : ""} ---`,
        `V1: ${p.v1}`,
        `V2: ${p.v2}`,
        ...(p.v4 ? [`V4: ${p.v4}`] : []),
        `V3: ${opts.useSceneDescAsV3 ? `(orijinal→EN) ${p.v3 || p.scene_desc}` : p.v3}`,
      ]),
  ];
  fs.writeFileSync(path.join(paths.outputDir, "gemini_direct_review.txt"), review.join("\n"), "utf8");

  log(`\n✅ TAMAM — ${lo}-${hi} güncellendi (toplam ${out.length} sahne)`);
  log(`📄 ${paths.promptsJson}`);
  return stoppedForQuota ? 1 : 0;
}
