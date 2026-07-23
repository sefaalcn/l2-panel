export type { HailuoContext } from "./context";
export { setupContext, getHailuoToken, getCookies, log } from "./context";
export { uploadImage, type UploadResult } from "./upload";
export {
  apiCall,
  heartbeat,
  waitForQueue,
  generateVideo,
  MAX_QUEUE,
  type UploadTuple,
} from "./api";
export { pollDownload, downloadStream, normalizePrompt } from "./poll";
export { hlParams, computeYy, buildQuery, hlHeaders } from "./sign";
export {
  HAILUO_BASE,
  HAILUO_MODEL_20,
  HAILUO_MODEL_23,
} from "./constants";

import { HAILUO_MODEL_20 } from "./constants";
import {
  generateVideo,
  heartbeat,
  waitForQueue,
  type UploadTuple,
} from "./api";
import { setupContext, getHailuoToken, log } from "./context";
import { normalizePrompt, pollDownload } from "./poll";
import { uploadImage } from "./upload";

export type SubmitJob = {
  videoDir: string;
  modelId?: string;
  label: string;
  frameMode: string;
  prompt: string;
  startImage?: string | null;
  endImage?: string | null;
  outPath: string;
  resumeVidId?: string | null;
  duration?: number;
  resolution?: string;
  promptOptimizer?: boolean;
  skipQueueGate?: boolean;
  preGenerate?: () => void | Promise<void>;
  onSubmit?: (vidId: string) => void | Promise<void>;
};

/** video_router._hailuo.submit portu — tek sahne üretimi */
export async function submitHailuoJob(job: SubmitJob): Promise<string> {
  const ctx = setupContext(job.videoDir, job.modelId || HAILUO_MODEL_20);
  const token = getHailuoToken(ctx);

  if (job.resumeVidId) {
    log(`>> [RESUME] ${job.label}: vid_id ${job.resumeVidId}`);
    return pollDownload(job.resumeVidId, token, ctx, job.outPath);
  }

  const mode = (job.frameMode || "both").toLowerCase();
  let first: UploadTuple;
  let last: UploadTuple;

  if (mode === "end_only") {
    if (!job.endImage) throw new Error("end_only ama frame_last yok");
    const up = await uploadImage(job.endImage, token, ctx);
    first = last = up;
  } else if (mode === "both") {
    if (!job.startImage || !job.endImage) throw new Error("both ama frame eksik");
    log(">> [0] first frame upload...");
    first = await uploadImage(job.startImage, token, ctx);
    await sleep(4000);
    log(">> [0] last frame upload...");
    last = await uploadImage(job.endImage, token, ctx, true);
  } else {
    if (!job.startImage) throw new Error("start_only ama frame_first yok");
    const up = await uploadImage(job.startImage, token, ctx);
    first = last = up;
  }
  await sleep(4000);

  if (!job.skipQueueGate) {
    try {
      await waitForQueue(token, ctx, job.label);
    } catch (e) {
      log(`   wait_for_queue atlandı: ${e}`);
    }
  }

  const prompt = normalizePrompt(job.prompt);
  const optimizerOn = job.promptOptimizer !== false;
  log(
    `   Optimizer: ${optimizerOn ? "AÇIK (Hailuo optimize eder, useOriginPrompt=false)" : "KAPALI (verbatim, useOriginPrompt=true)"}`,
  );
  let dur = job.duration ?? 6;
  let res = dur === 10 ? "768" : "1080";
  if (res !== "1080") {
    log(`   [UYARI] ${dur}sn için çözünürlük 720p (res=${res})`);
  }

  log(`>> [1] generate (${job.label}, model ${ctx.modelId}, mode=${mode})...`);
  if (job.preGenerate) await job.preGenerate();
  const vidId = await generateVideo(first, last, prompt, token, ctx, {
    frameMode: mode,
    duration: dur,
    resolution: res,
    useOriginPrompt: !optimizerOn,
  });
  log(`   vid_id: ${vidId}`);
  if (job.onSubmit) await job.onSubmit(vidId);
  await heartbeat(token, ctx);

  log(">> [2] sonuç bekleniyor (poll)...");
  return pollDownload(vidId, token, ctx, job.outPath);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
