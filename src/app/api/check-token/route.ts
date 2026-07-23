import { NextResponse } from "next/server";
import { extractFireflyCredsFromPaste } from "@/lib/pipeline/firefly/adobe-ingest";
import { tokenExpRemaining } from "@/lib/token";
import { EXPIRY_WARN_SEC, formatRemainingShort } from "@/lib/token-expiry";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  const raw = String(value || "").trim();
  if (!raw) return NextResponse.json({ valid: false, message: "boş" });

  const extracted = extractFireflyCredsFromPaste(raw);
  const v = (extracted.token || raw.replace(/^Bearer\s+/i, "")).trim();
  if (!v) return NextResponse.json({ valid: false, message: "boş" });

  const rem = tokenExpRemaining(v);
  if (rem === null) {
    return NextResponse.json({
      valid: null,
      message: extracted.fromCurl
        ? "cURL'de JWT okunamadı — Bearer satırını kontrol et"
        : "JWT değil / süre okunamadı",
      arp: Boolean(extracted.arp),
      nonce: Boolean(extracted.nonce),
    });
  }
  if (rem <= 0) {
    return NextResponse.json({
      valid: false,
      expires_in_h: Math.round((rem / 3600) * 10) / 10,
      expiring_soon: false,
      message: "SÜRESİ DOLMUŞ — F12'den yeni cURL al",
      arp: Boolean(extracted.arp),
      nonce: Boolean(extracted.nonce),
    });
  }
  const expiringSoon = rem <= EXPIRY_WARN_SEC;
  const extras = [
    extracted.arp ? "arp✓" : null,
    extracted.nonce ? "nonce✓" : null,
  ].filter(Boolean);
  const base = expiringSoon
    ? `⚠ ${formatRemainingShort(rem)} kaldı — yenile`
    : `geçerli, ${(rem / 3600).toFixed(1)}h kaldı`;
  return NextResponse.json({
    valid: true,
    expires_in_h: Math.round((rem / 3600) * 10) / 10,
    expires_in_min: Math.ceil(rem / 60),
    expiring_soon: expiringSoon,
    message: extras.length ? `${base} · ${extras.join(" · ")}` : base,
    arp: Boolean(extracted.arp),
    nonce: Boolean(extracted.nonce),
    from_curl: extracted.fromCurl,
  });
}
