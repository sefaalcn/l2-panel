/** Hailuo API sabitleri — hailuo_pipeline.py ile aynı. */
export const HAILUO_BASE = "https://hailuoai.video";
export const HAILUO_UUID = "004e1a0a-0ea8-41c2-8921-102eb9898e3b";
export const HAILUO_DEVICE_ID = "399744959216705542";
export const HAILUO_MODEL_20 = "23210";
export const HAILUO_MODEL_23 = "23217";

/**
 * Hailuo resmi negative / anti-prompt (-v …).
 * Odak: harekette morph / identity break (çocuk cartoon I2V).
 * Kaynak: hailuoai.video negative / anti-prompt rehberleri — kısa tut, kitchen-sink değil.
 */
export const HAILUO_NEGATIVE_PROMPT =
  "morphing, morphing textures, identity morph, face warp, melting, shape-shifting, " +
  "deformed limbs, extra fingers, duplicate face, head swelling, eyes popping out, " +
  "jittery motion, background warping";
