import fs from "fs";
import path from "path";
import { cleanStagedApiKeyFiles, resolveApiKey } from "@/lib/api-keys";
import { KEYFRAMES_SOURCE_FILE } from "@/lib/ingest";
import { writeRunstate } from "@/lib/runstate";
import { getPipelineEngine } from "./engines";
import type { RunOptions, RunPhase } from "./types";

const CRED_ENV_VARS = [
  "HAILUO_TOKEN_FILE",
  "HAILUO_COOKIE_FILE",
  "HAILUO_PROJECT_FILE",
  "FIREFLY_TOKEN_FILE",
  "FIREFLY_ARP_FILE",
  "FIREFLY_NONCE_FILE",
] as const;

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
    updateRunstate("basliyor", { project: projectName, provider: opts.provider, started_at: Date.now() / 1000 });

    updateRunstate("prompt_uretiliyor", { project: projectName });
    const rcPrompt = await engine.runPromptGeneration(opts, projectName);
    if (rcPrompt !== 0) {
      const hint =
        rcPrompt === 1 && !resolveApiKey("GEMINI_API_KEY", opts.env)
          ? "GEMINI_API_KEY worker'a ulaşmadı — panelde anahtarı yapıştırıp tekrar deneyin"
          : `prompt üretimi başarısız (rc=${rcPrompt})`;
      fs.appendFileSync(opts.logPath, `\n❌ ${hint}\n`, "utf8");
      updateRunstate("hata", { project: projectName, error: hint });
      return rcPrompt;
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
    cleanStagedApiKeyFiles();
  }
}
