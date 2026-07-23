import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { CODE_ROOT, MODELS, PANEL_DIR, PROJECTS_ROOT, sessionKeys } from "@/lib/config";
import { mergeApiKeysIntoEnv, resolveApiKey, stageApiKeysForWorker } from "@/lib/api-keys";
import { loadProjectScenes, projectNeedsGemini } from "@/lib/scenes";
import { loadCredentialFiles } from "@/lib/credentials";
import { projectHasFireflyScenes, projectHasHailuoScenes } from "@/lib/video-model";
import { KEYFRAMES_SOURCE_FILE, parseKeyframesSource } from "@/lib/ingest";
import { resolveActiveKeyframesDir } from "@/lib/pipeline/router/resolve";
import {
  cleanCredFiles,
  getActiveRun,
  listActiveRuns,
  safeRunId,
  writeRunstate,
} from "@/lib/runstate";
import {
  extractFireflyCredsFromPaste,
  persistFireflyCreds,
} from "@/lib/pipeline/firefly/adobe-ingest";

export const dynamic = "force-dynamic";

function stageCredential(
  cred: (typeof MODELS.hailuo.credentials)[number] | (typeof MODELS.firefly.credentials)[number],
  val: string,
  env: NodeJS.ProcessEnv,
  proj: string,
  projectName: string,
) {
  const tgt = cred.target as { type?: string; env?: string };
  if (tgt?.type === "file" && tgt.env) {
    let toWrite = val;
    // Firefly alanına cURL yapıştırıldıysa her şeyi ayıkla
    if (cred.key === "ff_token") {
      const extracted = extractFireflyCredsFromPaste(val);
      if (extracted.token) {
        persistFireflyCreds(extracted, CODE_ROOT);
        toWrite = extracted.token;
      } else if (/curl|authorization\s*:/i.test(val)) {
        throw new Error("Firefly cURL içinde Bearer token bulunamadı");
      }
    }
    const tag = safeRunId(projectName);
    const fpath = path.join(PANEL_DIR, `.l2_${tag}_${cred.key}.txt`);
    fs.mkdirSync(PANEL_DIR, { recursive: true });
    fs.writeFileSync(fpath, toWrite, "utf8");
    env[tgt.env] = fpath;
    if (cred.key === "ff_token") {
      fs.writeFileSync(path.join(CODE_ROOT, "firefly_token.txt"), toWrite, "utf8");
    }
    if (cred.key === "project") {
      fs.writeFileSync(path.join(CODE_ROOT, "hailuo_project.txt"), val, "utf8");
      fs.writeFileSync(path.join(proj, "hailuo_project.txt"), val, "utf8");
    }
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  const project = String(body.project || "").trim();
  const provider = "hailuo";
  const variants = String(body.variants || "v1");
  const concurrency = body.concurrency != null ? Number(body.concurrency) : null;
  const scenesFilter = body.scenes ? String(body.scenes) : null;
  const promptOptimizer = body.prompt_optimizer !== false;
  const keyframesSource = parseKeyframesSource(body.keyframes_source);
  const regeneratePrompts = body.regenerate_prompts === true;

  if (!project) {
    return NextResponse.json({ detail: "project gerekli" }, { status: 400 });
  }

  // Yalnız AYNI proje zaten koşuyorsa engelle — diğer sekmeler paralel açılabilir
  const mine = getActiveRun(project);
  if (mine) {
    return NextResponse.json(
      { detail: `Bu proje zaten koşuyor (pid ${mine.pid}, status=${mine.status})` },
      { status: 409 },
    );
  }
  cleanCredFiles(project);

  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  fs.writeFileSync(path.join(proj, KEYFRAMES_SOURCE_FILE), keyframesSource, "utf8");

  try {
    resolveActiveKeyframesDir(proj, keyframesSource);
  } catch (e) {
    cleanCredFiles(project);
    return NextResponse.json(
      { detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const bodyCreds = (body.credentials || {}) as Record<string, string>;
  const fileCreds = loadCredentialFiles(project);
  const credentials: Record<string, string> = { ...fileCreds };
  for (const [k, v] of Object.entries(bodyCreds)) {
    const trimmed = String(v || "").trim();
    if (trimmed) credentials[k] = trimmed;
  }

  const env = { ...process.env, ...sessionKeys } as NodeJS.ProcessEnv;
  env.L2_PROJECTS_ROOT = PROJECTS_ROOT;
  mergeApiKeysIntoEnv(env, body.api_keys as Record<string, string> | undefined);
  stageApiKeysForWorker(env, project);

  const projectScenes = loadProjectScenes(project);
  const promptsJson = path.join(proj, `${project}_output`, "hailuo_prompts_claude.json");
  let promptsComplete = false;
  if (!regeneratePrompts && fs.existsSync(promptsJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(promptsJson, "utf8"));
      const arr = Array.isArray(data) ? data : Array.isArray(data?.scenes) ? data.scenes : [];
      const byIdx = new Map<number, { v1?: unknown; v4?: unknown }>();
      for (const p of arr) {
        const idx = Number((p as { index?: number }).index);
        if (Number.isFinite(idx)) byIdx.set(idx, p as { v1?: unknown; v4?: unknown });
      }
      promptsComplete =
        projectScenes.length > 0 &&
        projectScenes.every((s) => {
          const idx = Number(s.index ?? 0);
          const p = byIdx.get(idx);
          return Boolean(String(p?.v1 || "").trim());
        });
    } catch {
      promptsComplete = false;
    }
  }
  if (
    (regeneratePrompts || !promptsComplete) &&
    projectNeedsGemini(projectScenes) &&
    !resolveApiKey("GEMINI_API_KEY", env)
  ) {
    cleanCredFiles(project);
    return NextResponse.json(
      {
        detail: "GEMINI_API_KEY gerekli — v1/v2 prompt üretimi (veya scene_description eksik)",
      },
      { status: 400 },
    );
  }

  const needHailuo = projectHasHailuoScenes(projectScenes);
  const needFirefly = projectHasFireflyScenes(projectScenes);
  if (!needHailuo && !needFirefly) {
    cleanCredFiles(project);
    return NextResponse.json({ detail: "Projede sahne yok" }, { status: 400 });
  }

  const others = listActiveRuns().filter((r) => r.project && r.project !== project);
  const queueHints: string[] = [];
  if (needHailuo && others.length) {
    queueHints.push("Hailuo aynı anda başka projede varsa sıraya girer");
  }
  if (needFirefly && others.length) {
    queueHints.push("Firefly aynı anda başka projede varsa sıraya girer");
  }

  const credGroups = [
    ...(needHailuo ? MODELS.hailuo.credentials : []),
    ...(needFirefly ? MODELS.firefly.credentials : []),
  ];

  for (const cred of credGroups) {
    let val = (credentials[cred.key] || "").trim();
    if ("autoFromFile" in cred && cred.autoFromFile && fileCreds[cred.key]) {
      val = fileCreds[cred.key].trim();
    }
    if (!val) {
      if (cred.required) {
        cleanCredFiles(project);
        const hint =
          "autoFromFile" in cred && cred.autoFromFile
            ? `${cred.label} gerekli — ${(cred.target as { name?: string }).name || "dosya"} (proje kökü veya proje klasörü)`
            : needFirefly && cred.key === "ff_token"
              ? "Firefly Token gerekli — JSON'da video_model≠hailuo sahneler var"
              : `${cred.label} gerekli`;
        return NextResponse.json({ detail: hint }, { status: 400 });
      }
      continue;
    }
    try {
      stageCredential(cred, val, env, proj, project);
    } catch (e) {
      cleanCredFiles(project);
      return NextResponse.json(
        { detail: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  const logf = path.join(proj, ".l2_run.log");
  const workerScript = path.join(CODE_ROOT, "src", "worker", "l2-run.ts");
  const args = [
    workerScript,
    "--project-path",
    proj,
    "--provider",
    provider,
    "--variants",
    variants,
    "--log",
    logf,
  ];
  if (concurrency) args.push("--concurrency", String(concurrency));
  if (scenesFilter) args.push("--scenes", scenesFilter);
  if (!promptOptimizer) args.push("--no-optimizer");
  if (regeneratePrompts) args.push("--regenerate-prompts");
  args.push("--keyframes-source", keyframesSource);

  const tsxCli = path.join(CODE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    cleanCredFiles(project);
    return NextResponse.json({ detail: "tsx bulunamadı — npm install çalıştır" }, { status: 500 });
  }

  try {
    const logFd = fs.openSync(logf, "a");
    const child = spawn(process.execPath, [tsxCli, ...args], {
      cwd: CODE_ROOT,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.unref();

    writeRunstate({
      pid: child.pid,
      project,
      provider,
      status: "basliyor",
      started_at: Date.now() / 1000,
    });

    return NextResponse.json({
      project,
      pid: child.pid,
      status: "basliyor",
      log: logf,
      runtime: "local",
      engine: "node",
      worker: "tsx",
      routing: needFirefly ? "hybrid (JSON video_model)" : "hailuo",
      parallel_ok: true,
      other_runs: others.map((r) => ({ project: r.project, pid: r.pid, status: r.status })),
      queue_note: queueHints.length ? queueHints.join(" · ") : null,
    });
  } catch (e) {
    cleanCredFiles(project);
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `Worker başlatılamadı: ${msg}` }, { status: 500 });
  }
}
