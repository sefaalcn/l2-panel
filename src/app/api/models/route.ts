import { NextResponse } from "next/server";
import { MODELS, COMMON_ENV, sessionKeys } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const env_set: Record<string, boolean> = {};
  for (const e of COMMON_ENV) {
    env_set[e.key] = Boolean(sessionKeys[e.key] || process.env[e.key]?.trim());
  }
  return NextResponse.json({ models: MODELS, common_env: COMMON_ENV, env_set, runtime: "local" });
}
