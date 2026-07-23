import { NextResponse } from "next/server";
import { saveApiKeyFile } from "@/lib/api-keys";
import { sessionKeys } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Gemini API key → gemini_api_key.txt */
export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  const v = String(value || "").trim();
  if (!v) {
    return NextResponse.json({ detail: "API key boş" }, { status: 400 });
  }
  if (v.length < 20) {
    return NextResponse.json(
      { detail: "API key çok kısa — Google AI Studio'dan tam anahtarı yapıştır" },
      { status: 400 },
    );
  }

  saveApiKeyFile("GEMINI_API_KEY", v);
  sessionKeys.GEMINI_API_KEY = v;

  return NextResponse.json({ ok: true, length: v.length, file: "gemini_api_key.txt" });
}
