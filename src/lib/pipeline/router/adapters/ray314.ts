import { uploadImage } from "../../firefly/client";
import { submitF3p } from "../../firefly/f3p";
import { type Job, register, retry } from "../core";

const NEGATIVE_PROMPT = "cartoon, vector art, & bad aesthetics & poor aesthetic";
const MODE = "flex_2";
const ASPECT_RATIO = "16:9";
const DEFAULT_RESOLUTION = "720p";
const SIZES: Record<string, [number, number]> = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
};

function buildPayload(job: Job, startId: string | null, endId: string | null) {
  const res = job.resolution && SIZES[job.resolution] ? job.resolution : DEFAULT_RESOLUTION;
  const [width, height] = SIZES[res];
  const referenceBlobs: Record<string, unknown>[] = [];
  if (startId) referenceBlobs.push({ id: startId, usage: "general", promptReference: 1 });
  if (endId) referenceBlobs.push({ id: endId, usage: "general", promptReference: 2 });
  const payload: Record<string, unknown> = {
    modelId: "luma",
    modelVersion: "3.14-ray",
    size: { width, height },
    mode: MODE,
    prompt: job.prompt,
    negativePrompt: NEGATIVE_PROMPT,
    duration: job.duration,
    generationMetadata: { module: "text2video", submodule: "ff-video-generate" },
    modelSpecificPayload: { resolution: res, aspect_ratio: ASPECT_RATIO },
    output: { storeInputs: true },
  };
  if (referenceBlobs.length) payload.referenceBlobs = referenceBlobs;
  return payload;
}

/** both (start+end) ve end_only (yalnız end) için ortak akış */
export async function generateRay314(job: Job): Promise<string> {
  const startId = job.startImage
    ? await retry(() => uploadImage(job.startImage!), { label: "upload" })
    : null;
  const endId = job.endImage
    ? await retry(() => uploadImage(job.endImage!), { label: "upload" })
    : null;
  const payload = buildPayload(job, startId, endId);
  return submitF3p(job, payload, null, null, "Ray3.14");
}

register({
  key: "ray3.14",
  provider: "firefly",
  modelTag: "ray314",
  modes: new Set(["both"]),
  ready: true,
  generate: generateRay314,
  description: "Luma Ray3.14 (both: start+end) — firefly-3p",
});

register({
  key: "ray3.14_end",
  provider: "firefly",
  modelTag: "ray314",
  modes: new Set(["end_only"]),
  ready: true,
  generate: generateRay314,
  description: "Ray3.14 end_only (frame_last -> promptReference 2)",
});
