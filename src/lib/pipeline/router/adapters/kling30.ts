import { uploadImage } from "../../firefly/client";
import { stableSeed, submitF3p } from "../../firefly/f3p";
import { type Job, register, retry } from "../core";

const NEGATIVE_PROMPT = "blur, distort, low quality, morphing, deformed limbs";
const DEFAULT_DURATION = 5;
/** Adobe Firefly 3p — Kling 3.0 I2V (2.5: kling_v2_5_turbo_pro_i2v deseni) */
const MODEL_VERSION = "kling_v3_pro_i2v";

function buildPayload(job: Job, startId: string | null, endId: string | null) {
  const referenceBlobs: Record<string, unknown>[] = [];
  if (startId) referenceBlobs.push({ id: startId, usage: "frame", order: 1 });
  if (endId) referenceBlobs.push({ id: endId, usage: "frame", order: 2 });

  return {
    modelId: "kling",
    modelVersion: MODEL_VERSION,
    size: { width: 1920, height: 1080 },
    seeds: [stableSeed(job)],
    referenceBlobs,
    prompt: job.prompt,
    duration: job.duration || DEFAULT_DURATION,
    generateAudio: false,
    generationMetadata: { module: "image2video", submodule: "ff-video-generate" },
    modelSpecificPayload: { aspect_ratio: "16:9", negative_prompt: NEGATIVE_PROMPT },
    output: { storeInputs: true },
  };
}

/** start_only | both | end_only — Kling 3.0 start+end destekli */
export async function generateKling30(job: Job): Promise<string> {
  const mode = String(job.scene.frame_mode || "start_only").toLowerCase();

  let startId: string | null = null;
  let endId: string | null = null;

  if (mode === "end_only") {
    if (!job.endImage) throw new Error("Kling 3.0 end_only ama frame_last yok");
    // Tek kare: son kareyi start (order 1) olarak gönder
    startId = await retry(() => uploadImage(job.endImage!), { label: "upload-end" });
  } else if (mode === "both") {
    if (!job.startImage || !job.endImage) {
      throw new Error("Kling 3.0 both ama frame_first/frame_last eksik");
    }
    startId = await retry(() => uploadImage(job.startImage!), { label: "upload-start" });
    endId = await retry(() => uploadImage(job.endImage!), { label: "upload-end" });
  } else {
    if (!job.startImage) throw new Error("Kling 3.0 start_only ama frame_first yok");
    startId = await retry(() => uploadImage(job.startImage!), { label: "upload-start" });
  }

  const payload = buildPayload(job, startId, endId);
  return submitF3p(job, payload, "kling_arp.txt", "kling_nonce.txt", "Kling 3.0");
}

register({
  key: "kling3.0",
  provider: "firefly",
  modelTag: "kling3",
  modes: new Set(["start_only", "both", "end_only"]),
  ready: true,
  description: "Kling 3.0 pro i2v (start_only + both start/end) — firefly-3p",
  generate: generateKling30,
});
