/** Faz 1-5 smoke testi — API çağrısı YOK (dry-run + saf fonksiyonlar). */
import fs from "fs";
import path from "path";
import { route } from "../src/lib/pipeline/router/router";
import { allAdapters, LocalSink } from "../src/lib/pipeline/router/core";
import "../src/lib/pipeline/router/adapters";
import { runPipeline } from "../src/lib/pipeline/router/runner";
import { parseScenesArg, parseVariantsFlag, resolveRouterPaths } from "../src/lib/pipeline/router/resolve";
import { ProgressStore, loadProgress } from "../src/lib/pipeline/router/progress";
import { computeYy, hlParams, buildQuery } from "../src/lib/pipeline/hailuo/sign";
import { classify } from "../src/lib/pipeline/router/moderation";
import { stableSeed } from "../src/lib/pipeline/firefly/f3p";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function main() {
  console.log("[1] router.route eşlemeleri");
  check("hailuo both -> hailuo2.0", route("hailuo", "both") === "hailuo2.0");
  check("hailuo end_only -> hailuo2.0", route("hailuo", "end_only") === "hailuo2.0");
  check("hailuo start_only -> hailuo2.3", route("hailuo", "start_only") === "hailuo2.3");
  check("firefly both -> ray3.14", route("firefly", "both") === "ray3.14");
  check("firefly end_only -> ray3.14_end", route("firefly", "end_only") === "ray3.14_end");
  check("firefly start kling", route("firefly", "start_only", 0, "kling") === "kling2.5");
  check("firefly start runway", route("firefly", "start_only", 0, "runway") === "runway4.5");
  check("firefly alternate çift", route("firefly", "start_only", 2, "alternate") === "kling2.5");
  check("firefly alternate tek", route("firefly", "start_only", 3, "alternate") === "runway4.5");

  console.log("[2] adaptor registry");
  const keys = [...allAdapters().keys()].sort();
  const expected = ["hailuo2.0", "hailuo2.3", "kling2.5", "ray3.14", "ray3.14_end", "runway4.5"];
  check(`kayıtlı adaptorler: ${keys.join(",")}`, JSON.stringify(keys) === JSON.stringify(expected));

  console.log("[3] yy imzası (sabit girdi, Python ile karşılaştırılacak)");
  const params = hlParams(1721460000000);
  const body = { projectID: "12345", quantity: 1 };
  const yy = computeYy("/v2/api/multimodal/generate/video", params, body);
  console.log(`  TS yy = ${yy}`);
  console.log(`  TS query = ${buildQuery(params).slice(0, 80)}...`);

  console.log("[4] moderation.classify");
  check("2400001 -> structural", classify(new Error("API error 2400001: x")) === "structural");
  check("2400002 -> moderation", classify(new Error("API error 2400002: x")) === "moderation");
  check("HTTP 451 -> moderation", classify(new Error("Ray3.14 generate-async HTTP 451")) === "moderation");
  check("timeout -> other", classify(new Error("ETIMEDOUT")) === "other");

  console.log("[5] stableSeed (Python md5 ile aynı formül)");
  const seed = stableSeed({
    scene: { label: "scene_001" },
    variant: "v1",
    prompt: "",
    startImage: null,
    endImage: null,
    outPath: "",
    duration: 5,
    videoDir: "",
  });
  console.log(`  seed(scene_001, v1) = ${seed}`);
  check("seed 0..999999 aralığında", seed >= 0 && seed < 1_000_000);

  console.log("[6] parse yardımcıları");
  check("variants v1,3 -> v1,v3", JSON.stringify(parseVariantsFlag("v1,3")) === JSON.stringify(["v1", "v3"]));
  check("scenes 1-3,7", JSON.stringify([...parseScenesArg("1-3,7")].sort((a, b) => a - b)) === JSON.stringify([1, 2, 3, 7]));

  console.log("[7] sahte proje + dry-run (hailuo ve firefly)");
  const root = path.join(__dirname, "proj", "DemoVid");
  fs.rmSync(path.join(__dirname, "proj"), { recursive: true, force: true });
  const outDir = path.join(root, "DemoVid_output");
  fs.mkdirSync(outDir, { recursive: true });
  const scenes = [
    { index: 1, label: "scene_001", frame_mode: "both", v1: "prompt a", v2: "prompt b" },
    { index: 2, label: "scene_002", frame_mode: "start_only", v1: "prompt c" },
    { index: 3, label: "scene_003", frame_mode: "end_only", v1: "prompt d" },
  ];
  fs.writeFileSync(path.join(outDir, "hailuo_prompts_claude.json"), JSON.stringify(scenes), "utf8");
  for (const s of scenes) {
    const d = path.join(root, "keyframes", s.label);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "frame_first.jpg"), "x");
    fs.writeFileSync(path.join(d, "frame_last.jpg"), "x");
  }

  const paths = resolveRouterPaths("hailuo", root);
  check("promptsJson yolu", paths.promptsJson.endsWith(path.join("DemoVid_output", "hailuo_prompts_claude.json")));
  check("çıktı klasörü hailuo_router_videos", paths.outputDir.endsWith("hailuo_router_videos"));

  const tallyH = await runPipeline({
    provider: "hailuo",
    promptsJson: paths.promptsJson,
    keyframesDir: paths.keyframesDir,
    videoDir: paths.videoDir,
    sink: new LocalSink(paths.outputDir),
    progressFile: paths.progressFile,
    variants: ["v1", "v2"],
    dryRun: true,
    log: () => {},
  });
  // v1: 3 sahne, v2: yalnız scene_001 -> 4 plan
  check(`hailuo dry-run planned=4 (gerçek: ${tallyH.planned})`, tallyH.planned === 4);

  const pathsF = resolveRouterPaths("firefly", root);
  const tallyF = await runPipeline({
    provider: "firefly",
    promptsJson: pathsF.promptsJson,
    keyframesDir: pathsF.keyframesDir,
    videoDir: pathsF.videoDir,
    sink: new LocalSink(pathsF.outputDir),
    progressFile: pathsF.progressFile,
    variants: ["v1"],
    startModel: "alternate",
    dryRun: true,
    log: () => {},
  });
  check(`firefly dry-run planned=3 (gerçek: ${tallyF.planned})`, tallyF.planned === 3);

  console.log("[8] ProgressStore atomik yazma + vid_id koruması");
  const progFile = path.join(root, "test_progress.json");
  const store = new ProgressStore(progFile);
  await store.setSubmitted("a.mp4", "vid-123", { scene: "scene_001" });
  await store.recordFailure("a.mp4", { status: "error", error: "boom" });
  const rec = loadProgress(progFile)["a.mp4"];
  check("vid_id korundu", rec?.vid_id === "vid-123" && rec?.status === "error");

  fs.rmSync(path.join(__dirname, "proj"), { recursive: true, force: true });

  console.log(failures ? `\n${failures} HATA` : "\nHEPSİ GEÇTİ");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
