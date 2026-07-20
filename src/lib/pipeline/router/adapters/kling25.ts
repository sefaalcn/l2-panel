import { uploadImage } from "../../firefly/client";
import { stableSeed, submitF3p } from "../../firefly/f3p";
import { type Job, register, retry } from "../core";

const NEGATIVE_PROMPT = "blur, distort, and low quality";
const DURATION = 5;

function buildPayload(job: Job, startId: string) {
  return {
    modelId: "kling",
    modelVersion: "kling_v2_5_turbo_pro_i2v",
    size: { width: 1920, height: 1080 },
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
  description: "Kling 2.5 turbo pro i2v (start_only, çift ordinal)",
  generate: async (job: Job) => {
    const startId = await retry(() => uploadImage(job.startImage!), { label: "upload" });
    const payload = buildPayload(job, startId);
    return submitF3p(job, payload, "kling_arp.txt", "kling_nonce.txt", "Kling 2.5");
  },
});
