import fs from "fs";
import path from "path";
import { sceneVariantKeys, loadProjectScenes, isGeekFree } from "@/lib/scenes";
import { routeScene, sceneUsesFirefly } from "@/lib/video-model";
import {
  type AdapterSpec,
  type Job,
  type OutputSink,
  type SceneRecord,
  getAdapter,
  sleepBetween,
} from "./core";
import "./adapters";
import * as moderation from "./moderation";
import { Pool, type PoolJob } from "./pool";
import { loadProgress, saveProgress, ProgressStore } from "./progress";

export type PipelineConfig = {
  provider: string;
  promptsJson: string;
  keyframesDir: string;
  videoDir: string;
  sink: OutputSink;
  progressFile: string;
  /** Hailuo koşusunda video_model≠hailuo sahneler için ayrı sink/progress */
  hybridSinks?: Partial<Record<"hailuo" | "firefly", OutputSink>>;
  hybridProgressFiles?: Partial<Record<"hailuo" | "firefly", string>>;
  variants: string[];
  startModel?: string;
  scenesFilter?: Set<number> | null;
  dryRun?: boolean;
  concurrency?: number | null;
  promptOptimizer?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
};

type ProviderKey = "hailuo" | "firefly";

function sceneSink(cfg: PipelineConfig, provider: ProviderKey): OutputSink {
  return cfg.hybridSinks?.[provider] ?? cfg.sink;
}

function sceneProgressFile(cfg: PipelineConfig, provider: ProviderKey): string {
  return cfg.hybridProgressFiles?.[provider] ?? cfg.progressFile;
}

type Tally = {
  produced: number;
  skipped: number;
  parked: number;
  failed: number;
  planned: number;
  submitted: number;
  softened: number;
};

const PACING: Record<string, { scene: [number, number]; variant: [number, number] }> = {
  firefly: { scene: [8, 20], variant: [8, 20] },
  hailuo: { scene: [20, 60], variant: [20, 60] },
};

const FIREFLY_FALLBACK: Record<string, string> = { kling: "runway4.5", runway: "kling2.5" };

const DURATION: Record<string, [Set<number> | null, number]> = {
  hailuo20: [new Set([6, 10]), 6],
  hailuo23: [new Set([6, 10]), 6],
  ray314: [new Set([5]), 5],
  runway: [new Set([8]), 8],
  kling: [new Set([5]), 5],
};

function resolveDuration(scene: SceneRecord, modelTag: string): [number, string | null] {
  const [accept, defaultDur] = DURATION[modelTag] ?? [null, 6];
  const raw = scene.video_duration;
  if (raw === null || raw === undefined || raw === "") return [defaultDur ?? 6, null];
  const req = Number(raw);
  if (!Number.isFinite(req)) {
    return [defaultDur ?? 6, `${modelTag}: video_duration geçersiz (${String(raw)}) -> ${defaultDur}s`];
  }
  if (!accept) return [req, null];
  if (accept.has(req)) return [req, null];
  const nearest = [...accept].sort((a, b) => Math.abs(a - req) - Math.abs(b - req))[0];
  return [
    nearest,
    `${modelTag}: ${req}s desteklenmiyor (kabul ${[...accept].sort()}) -> en yakın ${nearest}s`,
  ];
}

function findFrame(sceneDir: string, which: "first" | "last"): string {
  for (const ext of [".jpg", ".png"]) {
    const p = path.join(sceneDir, `frame_${which}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return path.join(sceneDir, `frame_${which}.jpg`);
}

function recordFailure(
  progress: Record<string, Record<string, unknown>>,
  outName: string,
  fields: Record<string, unknown>,
): boolean {
  const prev = progress[outName];
  const rec = { ...fields };
  if (prev?.vid_id && !rec.vid_id) rec.vid_id = prev.vid_id;
  progress[outName] = rec;
  return "vid_id" in rec;
}

async function retryStructural(
  spec: AdapterSpec,
  job: Job,
  firstExc: unknown,
  log: (s: string) => void,
): Promise<[string, AdapterSpec, Record<string, unknown>]> {
  const backoffs = [3, 6];
  let last = firstExc;
  for (let i = 0; i < 2; i++) {
    const wait = backoffs[Math.min(i, backoffs.length - 1)];
    log(`   [UYARI-2400001] structural/transient blip (${last}) -> ${wait}s bekle, yeniden dene (${i + 1}/2)...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    try {
      const out = await spec.generate(job);
      return [out, spec, { struct_retry: i + 1 }];
    } catch (e) {
      if (moderation.classify(e) !== "structural") throw e;
      last = e;
    }
  }
  throw new Error(`[2400001] 2 denemede geçmedi -> muhtemelen YAPISAL: ${last}`);
}

async function generateGuarded(
  spec: AdapterSpec,
  job: Job,
  cfg: PipelineConfig,
  mode: string,
  sceneProvider: ProviderKey,
): Promise<[string, AdapterSpec, Record<string, unknown>]> {
  const env = cfg.env ?? process.env;
  const log = cfg.log ?? console.log;
  const origPrompt = job.prompt;
  try {
    const out = await spec.generate(job);
    return [out, spec, {}];
  } catch (e0) {
    const kind = moderation.classify(e0);
    if (kind === "structural") return retryStructural(spec, job, e0, log);
    if (kind !== "moderation") throw e0;
    log(`   [S4] MODERASYON (${e0 instanceof Error ? e0.name : "Error"}) -> zincir başlıyor`);
  }

  for (let i = 0; i < 2; i++) {
    log(`   [S4] retry ${i + 1}/2 (aynı prompt)...`);
    try {
      const out = await spec.generate(job);
      return [out, spec, { mod_retry: i + 1 }];
    } catch (e) {
      if (moderation.classify(e) !== "moderation") throw e;
    }
  }

  if (moderation.moderationAvailable(env)) {
    const prior: string[] = [];
    for (let i = 0; i < 3; i++) {
      let soft: string;
      try {
        soft = await moderation.soften(origPrompt, i + 1, prior, env);
      } catch (se) {
        log(`   [S4] soften çağrısı hata (${se}) -> soften kademesi atlanıyor`);
        break;
      }
      prior.push(soft);
      job.prompt = soft;
      log(`   [S4] soften ${i + 1}/3 denendi`);
      try {
        const out = await spec.generate(job);
        return [out, spec, { softened: true, soften_attempt: i + 1, final_prompt: soft }];
      } catch (e) {
        if (moderation.classify(e) !== "moderation") {
          job.prompt = origPrompt;
          throw e;
        }
      }
    }
    job.prompt = origPrompt;
  } else {
    log("   [S4] ANTHROPIC_API_KEY yok -> yumuşatma ATLANDI");
  }

  // model fallback (YALNIZ Firefly start_only: kling<->runway)
  if (sceneProvider === "firefly" && mode === "start_only") {
    const fbKey = FIREFLY_FALLBACK[spec.modelTag];
    if (fbKey) {
      let fb: AdapterSpec | null = null;
      try {
        fb = getAdapter(fbKey);
      } catch {
        /* kayıtlı değil */
      }
      if (fb) {
        log(`   [S4] model fallback: ${spec.modelTag} -> ${fb.modelTag}`);
        job.prompt = origPrompt;
        try {
          const out = await fb.generate(job);
          return [out, fb, { fallback_from: spec.modelTag, fallback_to: fb.modelTag }];
        } catch (e) {
          log(`   [S4] fallback ${fb.modelTag} de başarısız: ${e}`);
        }
      }
    }
  }

  throw new Error(`[S4] moderasyon zinciri tükendi: ${origPrompt.slice(0, 60)}`);
}

function summary(cfg: PipelineConfig, tally: Tally, byModel: Record<string, number>, log: (s: string) => void) {
  log("\n" + "=".repeat(64));
  if (cfg.dryRun) {
    log(`DRY-RUN ÖZET: üretilecek=${tally.planned}  atlanacak=${tally.skipped}  park=${tally.parked}`);
  } else {
    log(
      `BİTTİ: üretildi=${tally.produced}  atlandı=${tally.skipped}  park=${tally.parked}  submitted=${tally.submitted}  başarısız=${tally.failed}`,
    );
    if (tally.submitted) {
      log(`  ⚠ submitted=${tally.submitted}: vid_id KAYITLI — resume poll+download ile alır.`);
    }
    if (tally.softened) {
      log(`  ⚠ softened=${tally.softened}: YUMUŞATILMIŞ promptla üretildi (S4).`);
    }
  }
  log(`Model dağılımı: ${JSON.stringify(byModel)}`);
  log(`Çıktı: ${cfg.sink.describe()}`);
  log(`Progress: ${cfg.progressFile}`);
  log("=".repeat(64));
}

function resolveVariantPrompt(s: SceneRecord, variant: string): string | null {
  if (variant === "v3") {
    const stored = String(s.v3 || "").trim();
    if (stored) return stored;
    const base = String(s.v1 || "").trim();
    const geek = String(s.geek || "").trim();
    if (base && geek) return `${base} ${geek}`.trim();
    return null;
  }
  const p = s[variant];
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

export async function runPipeline(cfg: PipelineConfig): Promise<Tally> {
  const log = cfg.log ?? console.log;
  if (!fs.existsSync(cfg.promptsJson)) {
    throw new Error(`prompt JSON yok: ${cfg.promptsJson}`);
  }

  const scenes = JSON.parse(fs.readFileSync(cfg.promptsJson, "utf8")) as SceneRecord[];
  scenes.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const manual = loadProjectScenes(path.basename(cfg.videoDir));
  const altByIdx: Record<number, unknown> = {};
  const geekByIdx: Record<number, boolean> = {};
  const vmodelByIdx: Record<number, unknown> = {};
  for (const m of manual) {
    const idx = Number(m.index ?? 0);
    altByIdx[idx] = m.alternative_scene;
    if (isGeekFree(m)) geekByIdx[idx] = true;
    if (m.video_model != null && String(m.video_model).trim()) {
      vmodelByIdx[idx] = m.video_model;
    }
  }
  for (const s of scenes) {
    const idx = Number(s.index ?? 0);
    if (s.alternative_scene == null && altByIdx[idx] != null) {
      s.alternative_scene = altByIdx[idx] as number;
    }
    if (s.geekfree == null && geekByIdx[idx]) {
      s.geekfree = true;
    }
    if ((s.video_model == null || s.video_model === "") && vmodelByIdx[idx] != null) {
      s.video_model = vmodelByIdx[idx];
    }
  }

  const hybridFirefly = cfg.provider === "hailuo" && scenes.some((s) => sceneUsesFirefly(s));
  const progressByProvider: Record<ProviderKey, Record<string, Record<string, unknown>>> = {
    hailuo: loadProgress(sceneProgressFile(cfg, "hailuo")),
    firefly: hybridFirefly ? loadProgress(sceneProgressFile(cfg, "firefly")) : {},
  };
  const saveProviderProgress = (provider: ProviderKey) => {
    saveProgress(sceneProgressFile(cfg, provider), progressByProvider[provider]);
  };

  const modeTag = cfg.dryRun ? "DRY-RUN (kredi harcanmaz)" : "GERÇEK ÜRETİM";
  log("=".repeat(64));
  log(`  ${cfg.provider.toUpperCase()} PIPELINE — ${modeTag}${hybridFirefly ? " (+ Firefly sahneler)" : ""}`);
  log(`  varyantlar : ${cfg.variants.join(",")}`);
  if (cfg.provider === "firefly") log(`  start_only : ${cfg.startModel || "kling"}`);
  if (hybridFirefly) {
    const ffCount = scenes.filter((s) => sceneUsesFirefly(s)).length;
    log(`  hybrid     : ${ffCount} sahne video_model → Firefly`);
  }
  log(`  çıktı      : ${cfg.sink.describe()}`);
  log(`  progress   : ${path.basename(cfg.progressFile)}`);
  if (cfg.scenesFilter?.size) log(`  sahne filt : ${[...cfg.scenesFilter].sort((a, b) => a - b)}`);
  log("=".repeat(64));

  if (cfg.concurrency != null && !cfg.dryRun && !hybridFirefly) {
    return runPool(cfg, scenes, progressByProvider, log);
  }

  const tally: Tally = {
    produced: 0,
    skipped: 0,
    parked: 0,
    failed: 0,
    planned: 0,
    submitted: 0,
    softened: 0,
  };
  const byModel: Record<string, number> = {};
  let startOnlyOrd = 0;
  let runGenerated = false;
  const pace = PACING[cfg.provider] ?? { scene: [4, 8] as [number, number], variant: [4, 8] as [number, number] };

  for (const s of scenes) {
    const idx = Number(s.index ?? 0);
    const label = String(s.label || `scene_${String(idx).padStart(3, "0")}`);
    const mode = String(s.frame_mode || "both");
    const ordinal = startOnlyOrd;
    if (mode === "start_only") startOnlyOrd += 1;
    if (cfg.scenesFilter && !cfg.scenesFilter.has(idx)) continue;

    const { provider: sceneProvider, adapterKey } = routeScene(
      s,
      ordinal,
      cfg.provider,
      cfg.startModel || "kling",
    );
    const spec = getAdapter(adapterKey);
    const sink = sceneSink(cfg, sceneProvider);
    const progress = progressByProvider[sceneProvider];
    const scenePace = PACING[sceneProvider] ?? pace;
    const sceneDir = path.join(cfg.keyframesDir, label);
    const firstImg = findFrame(sceneDir, "first");
    const lastImg = findFrame(sceneDir, "last");

    let startArg: string | null;
    let endArg: string | null;
    let required: string;
    if (mode === "end_only") {
      startArg = null;
      endArg = fs.existsSync(lastImg) ? lastImg : null;
      required = lastImg;
    } else {
      startArg = fs.existsSync(firstImg) ? firstImg : null;
      endArg = mode === "both" && fs.existsSync(lastImg) ? lastImg : null;
      required = firstImg;
    }

    const ordNote = mode === "start_only" ? ` ord=${ordinal}` : "";
    const vmNote = s.video_model ? ` vm=${s.video_model}` : "";
    log(
      `\n--- ${label}  (mode=${mode}${ordNote}${vmNote}) -> ${sceneProvider}/${adapterKey} [${spec.ready ? "HAZIR" : "PARK"}] ---`,
    );

    let sceneGenerated = false;

    for (const variant of sceneVariantKeys(s, cfg.variants)) {
      const outName = `${label}_${spec.modelTag}_${variant}.mp4`;
      byModel[spec.modelTag] = (byModel[spec.modelTag] || 0) + 1;

      if (sink.exists(outName)) {
        log(`   [${variant}] ATLA (zaten var): ${outName}`);
        tally.skipped += 1;
        continue;
      }

      if (!spec.ready) {
        log(`   [${variant}] PARK (adaptor yok: ${adapterKey}): ${outName}`);
        if (!cfg.dryRun) {
          progress[outName] = {
            status: "pending_no_adapter",
            provider: sceneProvider,
            adapter: adapterKey,
            model_tag: spec.modelTag,
            variant,
            scene: label,
            mode,
            video_model: s.video_model,
          };
          saveProviderProgress(sceneProvider);
        }
        tally.parked += 1;
        continue;
      }

      const prompt = resolveVariantPrompt(s, variant);
      if (!prompt || typeof prompt !== "string") {
        log(`   [${variant}] ATLA (JSON'da ${variant} yok)`);
        continue;
      }

      if (cfg.dryRun) {
        const needState = fs.existsSync(required) ? "var" : "YOK!";
        log(
          `   [${variant}] ÜRETİLECEK -> ${outName}  (girdi=${path.basename(required)}:${needState})`,
        );
        tally.planned += 1;
        continue;
      }

      const prev = progress[outName];
      const resumeVidId = prev?.vid_id ? String(prev.vid_id) : null;
      if (resumeVidId) {
        log(`   [${variant}] RESUME: vid_id=${resumeVidId} (prev=${prev?.status})`);
      }

      if (!resumeVidId && !fs.existsSync(required)) {
        log(`   [${variant}] HATA: gerekli kare yok: ${required}`);
        progress[outName] = { status: "no_input_frame", scene: label, variant };
        saveProviderProgress(sceneProvider);
        tally.failed += 1;
        continue;
      }

      if (runGenerated && !resumeVidId) {
        const [lo, hi] = sceneGenerated ? scenePace.variant : scenePace.scene;
        const gap = sceneGenerated ? "varyant-arası" : "sahne-arası";
        await sleepBetween(lo, hi, `${gap} (${sceneProvider})`, log);
      }
      if (!resumeVidId) {
        runGenerated = true;
        sceneGenerated = true;
      }

      const outPath = sink.localPath(outName);
      const onSubmit = async (vidId: string) => {
        progress[outName] = {
          status: "submitted",
          vid_id: vidId,
          provider: sceneProvider,
          adapter: adapterKey,
          model_tag: spec.modelTag,
          variant,
          scene: label,
          mode,
        };
        saveProviderProgress(sceneProvider);
        log(`   [progress] submitted kaydedildi (vid_id=${vidId})`);
      };

      const [dur, durWarn] = resolveDuration(s, spec.modelTag);
      if (durWarn) log(`   [UYARI-SÜRE] ${durWarn}`);

      const job: Job = {
        scene: s,
        variant,
        prompt,
        startImage: startArg,
        endImage: endArg,
        outPath,
        duration: dur,
        videoDir: cfg.videoDir,
        onSubmit,
        resumeVidId,
        promptOptimizer: cfg.promptOptimizer !== false,
      };

      try {
        const [produced, usedSpec, s4meta] = await generateGuarded(spec, job, cfg, mode, sceneProvider);
        const ref = sink.finalize(produced);
        const rec: Record<string, unknown> = {
          status: "done",
          provider: sceneProvider,
          adapter: adapterKey,
          model_tag: usedSpec.modelTag,
          variant,
          scene: label,
          mode,
          file: ref,
        };
        if (s4meta.softened) {
          rec.softened = true;
          rec.soften_attempt = s4meta.soften_attempt;
          rec.final_prompt = s4meta.final_prompt;
          tally.softened += 1;
        }
        progress[outName] = rec;
        saveProviderProgress(sceneProvider);
        tally.produced += 1;
        let extra = "";
        if (s4meta.softened) extra = `  [S4 SOFTENED #${s4meta.soften_attempt}]`;
        else if (s4meta.mod_retry) extra = `  [S4 retry #${s4meta.mod_retry} geçti]`;
        log(`   [${variant}] OK -> ${ref}${extra}`);
      } catch (e) {
        const recoverable = recordFailure(progress, outName, {
          status: "failed",
          adapter: adapterKey,
          model_tag: spec.modelTag,
          variant,
          scene: label,
          mode,
          error: String(e),
        });
        saveProviderProgress(sceneProvider);
        if (recoverable) {
          tally.submitted += 1;
          log(`   [${variant}] BAŞARISIZ ama vid_id KAYITLI -> resume kurtarır: ${e}`);
        } else {
          tally.failed += 1;
          log(`   [${variant}] BAŞARISIZ: ${e}`);
        }
        const msg = String(e);
        if (msg.includes("401") || msg.includes("403") || msg.includes("nonce")) {
          log("\n!! Kimlik/nonce hatası — duruyorum. Token yenileyip tekrar başlat.");
          summary(cfg, tally, byModel, log);
          return tally;
        }
      }
    }
  }

  summary(cfg, tally, byModel, log);
  return tally;
}

async function runPool(
  cfg: PipelineConfig,
  scenes: SceneRecord[],
  progressByProvider: Record<ProviderKey, Record<string, Record<string, unknown>>>,
  log: (s: string) => void,
): Promise<Tally> {
  const progress = progressByProvider.hailuo;
  const store = new ProgressStore(sceneProgressFile(cfg, "hailuo"));
  const pace = PACING[cfg.provider] ?? { scene: [20, 60] as [number, number], variant: [20, 60] as [number, number] };
  const pool = new Pool(cfg.concurrency!, store, pace.scene);
  const tally: Tally = {
    produced: 0,
    skipped: 0,
    parked: 0,
    failed: 0,
    planned: 0,
    submitted: 0,
    softened: 0,
  };
  const byModel: Record<string, number> = {};
  let startOnlyOrd = 0;
  const jobs: PoolJob[] = [];

  log(`  [POOL] concurrency=${cfg.concurrency}  pacing=${pace.scene}`);

  for (const s of scenes) {
    const idx = Number(s.index ?? 0);
    const label = String(s.label || `scene_${String(idx).padStart(3, "0")}`);
    const mode = String(s.frame_mode || "both");
    const ordinal = startOnlyOrd;
    if (mode === "start_only") startOnlyOrd += 1;
    if (cfg.scenesFilter && !cfg.scenesFilter.has(idx)) continue;
    if (sceneUsesFirefly(s)) continue;

    const { adapterKey } = routeScene(s, ordinal, cfg.provider, cfg.startModel || "kling");
    const spec = getAdapter(adapterKey);
    const sink = sceneSink(cfg, "hailuo");
    const sceneDir = path.join(cfg.keyframesDir, label);
    const firstImg = findFrame(sceneDir, "first");
    const lastImg = findFrame(sceneDir, "last");

    let startArg: string | null;
    let endArg: string | null;
    let required: string;
    if (mode === "end_only") {
      startArg = null;
      endArg = fs.existsSync(lastImg) ? lastImg : null;
      required = lastImg;
    } else {
      startArg = fs.existsSync(firstImg) ? firstImg : null;
      endArg = mode === "both" && fs.existsSync(lastImg) ? lastImg : null;
      required = firstImg;
    }

    for (const variant of sceneVariantKeys(s, cfg.variants)) {
      const outName = `${label}_${spec.modelTag}_${variant}.mp4`;
      byModel[spec.modelTag] = (byModel[spec.modelTag] || 0) + 1;

      if (sink.exists(outName)) {
        log(`   [${variant}] ATLA (zaten var): ${outName}`);
        tally.skipped += 1;
        continue;
      }
      if (!spec.ready) {
        await store.update(outName, {
          status: "pending_no_adapter",
          provider: "hailuo",
          adapter: adapterKey,
          model_tag: spec.modelTag,
          variant,
          scene: label,
          mode,
        });
        tally.parked += 1;
        continue;
      }

      const prompt = resolveVariantPrompt(s, variant);
      if (!prompt || typeof prompt !== "string") continue;

      const prev = progress[outName];
      const resumeVidId = prev?.vid_id ? String(prev.vid_id) : null;
      if (!resumeVidId && !fs.existsSync(required)) {
        await store.update(outName, { status: "no_input_frame", scene: label, variant });
        tally.failed += 1;
        continue;
      }

      const [dur, durWarn] = resolveDuration(s, spec.modelTag);
      if (durWarn) log(`   [UYARI-SÜRE] ${durWarn}`);

      jobs.push({
        scene: s,
        variant,
        prompt,
        startImage: startArg,
        endImage: endArg,
        outPath: sink.localPath(outName),
        duration: dur,
        videoDir: cfg.videoDir,
        resumeVidId,
        outName,
        promptOptimizer: cfg.promptOptimizer !== false,
        submitMeta: {
          provider: "hailuo",
          adapter: adapterKey,
          model_tag: spec.modelTag,
          variant,
          scene: label,
          mode,
        },
        _spec: spec,
        _mode: mode,
        _provider: "hailuo" as ProviderKey,
      });
    }
  }

  const produce = async (job: PoolJob) => {
    const spec = job._spec!;
    const mode = job._mode!;
    const sceneProvider = (job._provider as ProviderKey) || "hailuo";
    const sink = sceneSink(cfg, sceneProvider);
    const [produced, usedSpec, s4meta] = await generateGuarded(spec, job, cfg, mode, sceneProvider);
    const ref = sink.finalize(produced);
    const meta: Record<string, unknown> = { file: ref };
    if (s4meta.softened) {
      meta.softened = true;
      meta.soften_attempt = s4meta.soften_attempt;
      meta.final_prompt = s4meta.final_prompt;
    }
    return { path: ref, usedSpec, meta };
  };

  const onResult = (r: { ok: boolean; job: PoolJob; meta?: Record<string, unknown>; error?: string }) => {
    if (r.ok) {
      tally.produced += 1;
      let extra = "";
      if (r.meta?.softened) {
        tally.softened += 1;
        extra = `  [S4 SOFTENED #${r.meta.soften_attempt}]`;
      }
      log(`   [${r.job.variant}] OK -> ${r.job.outName}${extra}`);
    } else {
      const rec = store.get(r.job.outName!);
      if (rec?.vid_id) {
        tally.submitted += 1;
        log(`   [${r.job.variant}] BAŞARISIZ ama vid_id KAYITLI -> resume kurtarır: ${r.error}`);
      } else {
        tally.failed += 1;
        log(`   [${r.job.variant}] BAŞARISIZ: ${r.error}`);
      }
    }
  };

  log(`  [POOL] ${jobs.length} iş üretilecek`);
  await pool.run(jobs, produce, onResult);
  summary(cfg, tally, byModel, log);
  return tally;
}
