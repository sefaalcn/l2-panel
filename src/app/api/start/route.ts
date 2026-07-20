import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { CODE_ROOT, MODELS, PANEL_DIR, PROJECTS_ROOT, sessionKeys } from "@/lib/config";
import { mergeApiKeysIntoEnv, resolveApiKey, stageApiKeysForWorker } from "@/lib/api-keys";
import { loadProjectScenes, projectNeedsGemini } from "@/lib/scenes";
import { loadCredentialFiles } from "@/lib/credentials";
import { projectHasFireflyScenes } from "@/lib/video-model";
import { KEYFRAMES_SOURCE_FILE, parseKeyframesSource } from "@/lib/ingest";
import { activeRun, cleanCredFiles, writeRunstate } from "@/lib/runstate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const project = String(body.project || "").trim();
  const provider = String(body.provider || "hailuo");
  const variants = String(body.variants || "v1");
  const concurrency = body.concurrency != null ? Number(body.concurrency) : null;
  const scenesFilter = body.scenes ? String(body.scenes) : null;
  const promptOptimizer = body.prompt_optimizer !== false;
  const keyframesSource = parseKeyframesSource(body.keyframes_source);

  const active = activeRun();
  if (active) {
    return NextResponse.json(
      { detail: `zaten koşuyor: ${active.project} (status=${active.status}, pid=${active.pid})` },
      { status: 409 },
    );
  }
  cleanCredFiles();

  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  fs.writeFileSync(path.join(proj, KEYFRAMES_SOURCE_FILE), keyframesSource, "utf8");
  const model = MODELS[provider as keyof typeof MODELS];
  if (!model) {
    return NextResponse.json({ detail: `Bilinmeyen model: ${provider}` }, { status: 400 });
  }

  const bodyCreds = (body.credentials || {}) as Record<string, string>;
  const fileCreds = loadCredentialFiles(project);
  const credentials = { ...fileCreds, ...bodyCreds };
  for (const cred of model.credentials) {
    if ("autoFromFile" in cred && cred.autoFromFile && fileCreds[cred.key]) {
      credentials[cred.key] = fileCreds[cred.key];
    }
  }

  const env = { ...process.env, ...sessionKeys } as NodeJS.ProcessEnv;
  mergeApiKeysIntoEnv(env, body.api_keys as Record<string, string> | undefined);
  stageApiKeysForWorker(env);

  const projectScenes = loadProjectScenes(project);
  if (projectNeedsGemini(projectScenes) && !resolveApiKey("GEMINI_API_KEY", env)) {
    cleanCredFiles();
    return NextResponse.json(
      {
        detail:
          "GEMINI_API_KEY gerekli — alternative_scene≥2 veya geekfree sahneler var (veya scene_description eksik)",
      },
      { status: 400 },
    );
  }

  for (const cred of model.credentials) {
    const val = (credentials[cred.key] || "").trim();
    if (!val) {
      if (cred.required) {
        cleanCredFiles();
        const hint =
          "autoFromFile" in cred && cred.autoFromFile
            ? `${cred.label} gerekli — ${(cred.target as { name?: string }).name || "dosya"} (proje kökü veya proje klasörü)`
            : `${cred.label} gerekli`;
        return NextResponse.json({ detail: hint }, { status: 400 });
      }
      continue;
    }
    const tgt = cred.target as { type?: string; env?: string };
    if (tgt?.type === "file" && tgt.env) {
      const fpath = path.join(PANEL_DIR, `.l2_${cred.key}.txt`);
      fs.mkdirSync(PANEL_DIR, { recursive: true });
      fs.writeFileSync(fpath, val, "utf8");
      env[tgt.env] = fpath;
      if (cred.key === "ff_token") {
        fs.writeFileSync(path.join(CODE_ROOT, "firefly_token.txt"), val, "utf8");
      }
    }
  }

  if (provider === "hailuo" && projectHasFireflyScenes(projectScenes)) {
    const ffCreds = MODELS.firefly.credentials;
    for (const cred of ffCreds) {
      let val = (credentials[cred.key] || fileCreds[cred.key] || "").trim();
      if ("autoFromFile" in cred && cred.autoFromFile && fileCreds[cred.key]) {
        val = fileCreds[cred.key].trim();
      }
      if (!val) {
        if (cred.required) {
          cleanCredFiles();
          return NextResponse.json(
            {
              detail:
                "Firefly Token gerekli — JSON'da video_model≠hailuo sahneler var (örn. kling_2_5_turbo)",
            },
            { status: 400 },
          );
        }
        continue;
      }
      const tgt = cred.target as { type?: string; env?: string };
      if (tgt?.type === "file" && tgt.env) {
        const fpath = path.join(PANEL_DIR, `.l2_${cred.key}.txt`);
        fs.mkdirSync(PANEL_DIR, { recursive: true });
        fs.writeFileSync(fpath, val, "utf8");
        env[tgt.env] = fpath;
        if (cred.key === "ff_token") {
          fs.writeFileSync(path.join(CODE_ROOT, "firefly_token.txt"), val, "utf8");
        }
      }
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
  args.push("--keyframes-source", keyframesSource);

  const tsxCli = path.join(CODE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    cleanCredFiles();
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
    });
  } catch (e) {
    cleanCredFiles();
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `Worker başlatılamadı: ${msg}` }, { status: 500 });
  }
}
