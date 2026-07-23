import { uploadImage } from "../../firefly/client";
import { stableSeed, submitF3p } from "../../firefly/f3p";
import { type Job, register, retry } from "../core";

const DURATION = 8;

function buildPayload(job: Job, startId: string) {
  return {
    modelId: "runway",
    modelVersion: "gen4.5",
    size: { height: 720, width: 1280 },
    seeds: [stableSeed(job)],
    referenceBlobs: [{ id: startId, usage: "general", promptReference: 1 }],
    prompt: job.prompt,
    duration: job.duration || DURATION,
    generationMetadata: { module: "text2video", submodule: "ff-video-generate" },
    output: { storeInputs: true },
  };
}

register({
  key: "runway4.5",
  provider: "firefly",
  modelTag: "runway",
  modes: new Set(["start_only"]),
  ready: true,
  description: "Runway Gen-4.5 (start_only, tek ordinal) — 720p/8sn",
  generate: async (job: Job) => {
    const startId = await retry(() => uploadImage(job.startImage!), { label: "upload" });
    const payload = buildPayload(job, startId);
    return submitF3p(job, payload, "runway_arp.txt", "runway_nonce.txt", "Runway 4.5");
  },
});
