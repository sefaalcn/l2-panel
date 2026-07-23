import { NextResponse } from "next/server";
import {
  API_KEY_NAMES,
  apiKeyIsSet,
  isPlausibleApiKey,
  resolveApiKey,
  saveApiKeyFile,
} from "@/lib/api-keys";
import { sessionKeys } from "@/lib/config";

export const dynamic = "force-dynamic";

function maskKey(v: string): string {
  if (v.length <= 10) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

export async function GET() {
  const keys: Record<string, { set: boolean; masked?: string }> = {};
  for (const name of API_KEY_NAMES) {
    const v = resolveApiKey(name);
    keys[name] = v ? { set: true, masked: maskKey(v) } : { set: false };
  }
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, string | null | undefined>;
  for (const k of API_KEY_NAMES) {
    if (!(k in body)) continue;
    const v = String(body[k] || "").trim();
    if (v) {
      if (!isPlausibleApiKey(k, v)) {
        return NextResponse.json(
          { detail: `${k} geçersiz — tam anahtarı yapıştır` },
          { status: 400 },
        );
      }
      sessionKeys[k] = v;
      saveApiKeyFile(k, v);
    } else {
      // Boş gönderim kayıtlı dosyayı silmesin — sadece oturum önbelleğini temizle
      delete sessionKeys[k];
    }
  }
  return NextResponse.json({
    GEMINI_API_KEY: apiKeyIsSet("GEMINI_API_KEY"),
    ANTHROPIC_API_KEY: apiKeyIsSet("ANTHROPIC_API_KEY"),
  });
}
