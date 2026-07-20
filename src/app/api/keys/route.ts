import { NextResponse } from "next/server";
import { API_KEY_NAMES, apiKeyIsSet, saveApiKeyFile } from "@/lib/api-keys";
import { sessionKeys } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, string | null | undefined>;
  for (const k of API_KEY_NAMES) {
    if (!(k in body)) continue;
    const v = String(body[k] || "").trim();
    if (v) {
      sessionKeys[k] = v;
      saveApiKeyFile(k, v);
    } else {
      delete sessionKeys[k];
      saveApiKeyFile(k, "");
    }
  }
  return NextResponse.json({
    GEMINI_API_KEY: apiKeyIsSet("GEMINI_API_KEY"),
    ANTHROPIC_API_KEY: apiKeyIsSet("ANTHROPIC_API_KEY"),
  });
}
