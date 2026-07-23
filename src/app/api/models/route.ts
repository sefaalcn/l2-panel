import { NextResponse } from "next/server";
import { apiKeyIsSet } from "@/lib/api-keys";
import { COMMON_ENV, FIREFLY_VIDEO_MODELS, MODELS } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const env_set: Record<string, boolean> = {};
  for (const e of COMMON_ENV) {
    env_set[e.key] = apiKeyIsSet(e.key as "GEMINI_API_KEY" | "ANTHROPIC_API_KEY");
  }
  return NextResponse.json({
    models: MODELS,
    firefly_video_models: FIREFLY_VIDEO_MODELS,
    common_env: COMMON_ENV,
    env_set,
    runtime: "local",
  });
}
