#!/usr/bin/env node
/**
 * L2.5 koşu worker — TypeScript orchestrator (l2_panel/l2_run.py yerine).
 * Panel /api/start bunu detached spawn eder.
 *
 * Kullanım:
 *   npx tsx src/worker/l2-run.ts --project-path ./projects/foo --log ./projects/foo/.l2_run.log
 */
import { parseKeyframesSource } from "../lib/ingest";
import { enrichEnvFromKeyFiles } from "../lib/api-keys";
import { runPipeline } from "../lib/pipeline/orchestrator";
import type { RunOptions } from "../lib/pipeline/types";

function parseArgs(argv: string[]) {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i < 0 || i + 1 >= argv.length) return null;
    return argv[i + 1];
  };
  const has = (flag: string) => argv.includes(flag);

  const projectPath = get("--project-path");
  const logPath = get("--log");
  if (!projectPath || !logPath) {
    console.error("Kullanım: l2-run.ts --project-path <dir> --log <file> [--provider hailuo] ...");
    process.exit(2);
  }

  const concurrencyRaw = get("--concurrency");
  const opts: RunOptions = {
    projectPath,
    logPath,
    provider: get("--provider") || "hailuo",
    variants: get("--variants") || "v1",
    concurrency: concurrencyRaw ? Number(concurrencyRaw) : null,
    scenes: get("--scenes"),
    noOptimizer: has("--no-optimizer"),
    keyframesSource: parseKeyframesSource(get("--keyframes-source")),
    env: { ...process.env },
  };
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  enrichEnvFromKeyFiles(opts.env);

  process.on("SIGTERM", () => {
    process.exit(143);
  });

  const rc = await runPipeline(opts);
  process.exit(rc);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
