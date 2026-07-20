import type { SceneRow } from "./scenes";
import { route } from "./pipeline/router/router";

/** JSON video_model → normalize (küçük harf, tire→alt çizgi) */
export function normalizeVideoModel(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

/** hailuo / boş / eksik → Hailuo motoru */
export function isHailuoVideoModel(raw: unknown): boolean {
  const n = normalizeVideoModel(raw);
  if (!n) return true;
  if (n === "hailuo") return true;
  if (n.startsWith("hailuo_") || n.startsWith("hailuo2")) return true;
  return false;
}

export function sceneUsesFirefly(scene: SceneRow): boolean {
  return !isHailuoVideoModel(scene.video_model);
}

export function projectHasFireflyScenes(scenes: SceneRow[]): boolean {
  return scenes.some(sceneUsesFirefly);
}

/** Firefly 3p adaptor anahtarı — JSON video_model adından */
export function fireflyAdapterFromVideoModel(
  raw: unknown,
  frameMode: string,
  ordinal = 0,
): string {
  const n = normalizeVideoModel(raw);
  const mode = (frameMode || "both").toLowerCase();

  if (n.includes("kling") && (n.includes("2_5") || n.includes("25") || n.includes("turbo"))) {
    return "kling2.5";
  }
  if (n === "kling" || n.startsWith("kling_")) {
    return "kling2.5";
  }
  if (n.includes("runway") || n.includes("gen4") || n.includes("gen_4")) {
    return "runway4.5";
  }
  if (n.includes("ray") || n.includes("luma")) {
    return mode === "end_only" ? "ray3.14_end" : "ray3.14";
  }

  return route("firefly", mode, ordinal, "kling");
}

export type SceneRoute = {
  provider: "hailuo" | "firefly";
  adapterKey: string;
};

/**
 * Sahne yönlendirmesi:
 * - Panel hailuo + video_model hailuo/boş → Hailuo
 * - Panel hailuo + video_model başka (kling_2_5_turbo vb.) → Firefly adaptörü
 * - Panel firefly → tüm sahneler mevcut firefly frame_mode kuralları
 */
export function routeScene(
  scene: SceneRow,
  ordinal: number,
  globalProvider: string,
  startModel = "kling",
): SceneRoute {
  const mode = String(scene.frame_mode || "both");
  const gp = globalProvider.toLowerCase();

  if (gp === "hailuo" && sceneUsesFirefly(scene)) {
    return {
      provider: "firefly",
      adapterKey: fireflyAdapterFromVideoModel(scene.video_model, mode, ordinal),
    };
  }

  if (gp === "firefly") {
    return {
      provider: "firefly",
      adapterKey: route("firefly", mode, ordinal, startModel),
    };
  }

  return {
    provider: "hailuo",
    adapterKey: route("hailuo", mode, ordinal, startModel),
  };
}
