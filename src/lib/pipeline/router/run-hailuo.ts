import fs from "fs";
import type { RunOptions } from "../types";
import { LocalSink } from "./core";
import { runPipeline } from "./runner";
import { parseScenesArg, parseVariantsFlag, resolveRouterPaths } from "./resolve";

function makeLogger(logPath: string) {
  return (msg: string) => {
    const line = msg.endsWith("\n") ? msg : `${msg}\n`;
    process.stdout.write(line);
    try {
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      /* */
    }
  };
}

/** video_router.run_hailuo portu — Node motor girişi */
export async function runHailuoRouter(opts: RunOptions): Promise<number> {
  const paths = resolveRouterPaths("hailuo", opts.projectPath, opts.keyframesSource);
  const log = makeLogger(opts.logPath);

  log(`[cli] keyframes_dir=${paths.keyframesDir}`);

  const variants = parseVariantsFlag(opts.variants);
  const scenesFilter = opts.scenes ? parseScenesArg(opts.scenes) : null;

  let concurrency = opts.concurrency;
  if (concurrency == null) concurrency = 2;
  if (concurrency <= 1) concurrency = 1;

  const sink = new LocalSink(paths.outputDir);
  const tally = await runPipeline({
    provider: "hailuo",
    promptsJson: paths.promptsJson,
    keyframesDir: paths.keyframesDir,
    videoDir: paths.videoDir,
    sink,
    progressFile: paths.progressFile,
    variants,
    scenesFilter,
    concurrency,
    promptOptimizer: !opts.noOptimizer,
    env: opts.env,
    log: (msg) => log(msg),
  });

  return tally.failed > 0 && tally.produced === 0 && tally.submitted === 0 ? 1 : 0;
}
