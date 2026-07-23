import { uploadImage } from "../../firefly/client";
import { stableSeed, submitF3p } from "../../firefly/f3p";
import { type Job, register, retry } from "../core";

const DURATION = 5;
/** Tarayıcının Kling 2.5 default'u 1080p — 720p bazı hesaplarda 408 döndürüyor */
const DEFAULT_RESOLUTION = "1080p";
const SIZES: Record<string, [number, number]> = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
};

const NEGATIVE_PROMPT = "blur, distort, and low quality";

function buildPayload(job: Job, startId: string) {
  const res = job.resolution && SIZES[job.resolution] ? job.resolution : DEFAULT_RESOLUTION;
  const [width, height] = SIZES[res];
  return {
    modelId: "kling",
    modelVersion: "kling_v2_5_turbo_pro_i2v",
    // Firefox cURL sırası: height ilk, width sonra
    size: { height, width },
    seeds: [stableSeed(job)],
    referenceBlobs: [{ id: startId, usage: "frame", order: 1 }],
    prompt: job.prompt,
    duration: job.duration || DURATION,
    generateAudio: false,
    generationMetadata: { module: "image2video", submodule: "ff-video-generate" },
    modelSpecificPayload: { aspect_ratio: "16:9", negative_prompt: NEGATIVE_PROMPT },
    output: { storeInputs: true },
  };
}

register({
  key: "kling2.5",
  provider: "firefly",
  modelTag: "kling",
  modes: new Set(["start_only"]),
  ready: true,
  description: "Kling 2.5 turbo pro i2v (start_only, 1080p)",
  generate: async (job: Job) => {
    const startId = await retry(() => uploadImage(job.startImage!), { label: "upload" });
    const payload = buildPayload(job, startId);
    return submitF3p(job, payload, "kling_arp.txt", "kling_nonce.txt", "Kling 2.5");
  },
});
