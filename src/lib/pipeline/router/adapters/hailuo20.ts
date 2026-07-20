import { submitHailuoJob } from "../../hailuo";
import { HAILUO_MODEL_20 } from "../../hailuo/constants";
import { type Job, register } from "../core";

register({
  key: "hailuo2.0",
  provider: "hailuo",
  modelTag: "hailuo20",
  modes: new Set(["both", "end_only"]),
  ready: true,
  description: "Hailuo 2.0 (both + end_only, model 23210)",
  generate: async (job: Job) => {
    return submitHailuoJob({
      videoDir: job.videoDir,
      modelId: HAILUO_MODEL_20,
      label: String(job.scene.label || ""),
      frameMode: String(job.scene.frame_mode || "both"),
      prompt: job.prompt,
      startImage: job.startImage,
      endImage: job.endImage,
      outPath: job.outPath,
      resumeVidId: job.resumeVidId,
      duration: job.duration,
      resolution: job.resolution ?? undefined,
      promptOptimizer: job.promptOptimizer !== false,
      skipQueueGate: job.skipQueueGate,
      preGenerate: job.preGenerate,
      onSubmit: job.onSubmit,
    });
  },
});
