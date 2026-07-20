/** (provider, frame_mode, ordinal) → adaptor anahtarı — video_router/router.py portu */
export function route(
  provider: string,
  frameMode: string,
  ordinal = 0,
  startModel = "kling",
): string {
  const p = provider.toLowerCase();
  const mode = (frameMode || "both").toLowerCase();

  if (p === "firefly") {
    if (mode === "both") return "ray3.14";
    if (mode === "end_only") return "ray3.14_end";
    if (mode === "start_only") {
      const sm = (startModel || "kling").toLowerCase();
      if (sm === "kling") return "kling2.5";
      if (sm === "runway") return "runway4.5";
      if (sm === "alternate") return ordinal % 2 === 0 ? "kling2.5" : "runway4.5";
      throw new Error(`Bilinmeyen start_model: ${startModel}`);
    }
  } else if (p === "hailuo") {
    if (mode === "both" || mode === "end_only") return "hailuo2.0";
    if (mode === "start_only") return "hailuo2.3";
  }

  throw new Error(`Yönlendirilemedi: provider=${provider} frame_mode=${mode}`);
}
