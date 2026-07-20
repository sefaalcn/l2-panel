import { submitHailuoJob } from "../../hailuo";
import { HAILUO_MODEL_23 } from "../../hailuo/constants";
import { type Job, register } from "../core";

register({
  key: "hailuo2.3",
  provider: "hailuo",
  modelTag: "hailuo23",
  modes: new Set(["start_only"]),
  ready: true,
  description: "Hailuo 2.3 (start_only, model 23217)",
  generate: async (job: Job) => {
    return submitHailuoJob({
      videoDir: job.videoDir,
      modelId: HAILUO_MODEL_23,
      label: String(job.scene.label || ""),
      frameMode: String(job.scene.frame_mode || "start_only"),
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
