import fs from "fs";
import path from "path";
import { KEYFRAMES_SOURCE_FILE } from "@/lib/ingest";
import { writeRunstate } from "@/lib/runstate";
import { getPipelineEngine } from "./engines";
import type { RunOptions, RunPhase } from "./types";

const CRED_ENV_VARS = ["HAILUO_TOKEN_FILE", "HAILUO_COOKIE_FILE", "HAILUO_PROJECT_FILE"] as const;

function updateRunstate(phase: RunPhase, extra: Record<string, unknown> = {}) {
  writeRunstate({
    status: phase,
    pid: process.pid,
    updated_at: Date.now() / 1000,
    ...extra,
  } as Parameters<typeof writeRunstate>[0]);
}

export function cleanupCredentialFiles(env: NodeJS.ProcessEnv) {
  for (const key of CRED_ENV_VARS) {
    const f = env[key];
    if (!f) continue;
    try {
      fs.unlinkSync(f);
    } catch {
      /* */
    }
  }
}

function promptsPath(projectPath: string, projectName: string): string {
  return path.join(projectPath, `${projectName}_output`, "hailuo_prompts_claude.json");
}

export async function runPipeline(opts: RunOptions): Promise<number> {
  const projectName = path.basename(opts.projectPath);
  const engine = getPipelineEngine();

  fs.mkdirSync(opts.projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(opts.projectPath, KEYFRAMES_SOURCE_FILE),
    opts.keyframesSource,
    "utf8",
  );

  const logHeader = `\n=== orchestrator (${engine.name}) pid=${process.pid} ===\n`;
  fs.appendFileSync(opts.logPath, logHeader, "utf8");

  let exitCode = 0;

  try {
    updateRunstate("basliyor", { project: projectName, started_at: Date.now() / 1000 });

    const prompts = promptsPath(opts.projectPath, projectName);
    if (!fs.existsSync(prompts)) {
      updateRunstate("prompt_uretiliyor", { project: projectName });
      const rc = await engine.runPromptGeneration(opts, projectName);
      if (rc !== 0) {
        updateRunstate("hata", { project: projectName, error: `prompt rc=${rc}` });
        return rc;
      }
    }

    updateRunstate("video_uretiliyor", { project: projectName });
    const rc = await engine.runVideoProduction(opts, projectName);
    exitCode = rc;
    updateRunstate(rc === 0 ? "bitti" : "hata", { project: projectName, rc });
    return rc;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fs.appendFileSync(opts.logPath, `\nORCHESTRATOR ERROR: ${msg}\n`, "utf8");
    updateRunstate("hata", { project: projectName, error: msg });
    return 1;
  } finally {
    cleanupCredentialFiles(opts.env);
  }
}
