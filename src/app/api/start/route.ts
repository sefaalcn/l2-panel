import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { CODE_ROOT, MODELS, PANEL_DIR, PROJECTS_ROOT, sessionKeys } from "@/lib/config";
import { activeRun, cleanCredFiles, writeRunstate } from "@/lib/runstate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const project = String(body.project || "").trim();
  const provider = String(body.provider || "hailuo");
  const variants = String(body.variants || "v1");
  const concurrency = body.concurrency != null ? Number(body.concurrency) : null;
  const scenes = body.scenes ? String(body.scenes) : null;
  const credentials = (body.credentials || {}) as Record<string, string>;
  const promptOptimizer = body.prompt_optimizer !== false;

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
  const model = MODELS[provider as keyof typeof MODELS];
  if (!model) {
    return NextResponse.json({ detail: `Bilinmeyen model: ${provider}` }, { status: 400 });
  }

  const env = { ...process.env, ...sessionKeys } as NodeJS.ProcessEnv;
  for (const cred of model.credentials) {
    const val = (credentials[cred.key] || "").trim();
    if (!val) {
      if (cred.required) {
        cleanCredFiles();
        return NextResponse.json({ detail: `${cred.label} gerekli` }, { status: 400 });
      }
      continue;
    }
    const tgt = cred.target as { type?: string; env?: string };
    if (tgt?.type === "file" && tgt.env) {
      const fpath = path.join(PANEL_DIR, `.l2_${cred.key}.txt`);
      fs.mkdirSync(PANEL_DIR, { recursive: true });
      fs.writeFileSync(fpath, val, "utf8");
      env[tgt.env] = fpath;
    }
  }

  const logf = path.join(proj, ".l2_run.log");
  const py = process.env.L2_PYTHON || "python";
  const args = [
    "-m",
    "l2_panel.l2_run",
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
  if (scenes) args.push("--scenes", scenes);
  if (!promptOptimizer) args.push("--no-optimizer");

  const child = spawn(py, args, {
    cwd: CODE_ROOT,
    env,
    detached: true,
    stdio: "ignore",
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
  });
}
