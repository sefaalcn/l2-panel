import { NextResponse } from "next/server";
import { tokenExpRemaining } from "@/lib/token";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  const v = (value || "").replace(/^Bearer\s+/i, "").trim();
  if (!v) return NextResponse.json({ valid: false, message: "boş" });
  const rem = tokenExpRemaining(v);
  if (rem === null) {
    return NextResponse.json({ valid: null, message: "JWT değil / expiry okunamadı (Firefly token olabilir)" });
  }
  if (rem <= 0) {
    return NextResponse.json({
      valid: false,
      expires_in_h: Math.round((rem / 3600) * 10) / 10,
      message: "SÜRESİ DOLMUŞ — F12'den yenile",
    });
  }
  return NextResponse.json({
    valid: true,
    expires_in_h: Math.round((rem / 3600) * 10) / 10,
    message: `geçerli, ${(rem / 3600).toFixed(1)}h kaldı`,
  });
}
