import { NextResponse } from "next/server";
import { sessionKeys } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, string | null | undefined>;
  for (const k of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY"] as const) {
    if (!(k in body)) continue;
    const v = (body[k] || "").trim();
    if (v) sessionKeys[k] = v;
    else delete sessionKeys[k];
  }
  return NextResponse.json({
    GEMINI_API_KEY: Boolean(sessionKeys.GEMINI_API_KEY || process.env.GEMINI_API_KEY?.trim()),
    ANTHROPIC_API_KEY: Boolean(sessionKeys.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY?.trim()),
  });
}
