import { NextResponse } from "next/server";
import { CODE_ROOT } from "@/lib/config";
import {
  extractFireflyCredsFromPaste,
  persistFireflyCreds,
} from "@/lib/pipeline/firefly/adobe-ingest";
import { tokenExpRemaining } from "@/lib/token";
import { EXPIRY_WARN_SEC, formatRemainingShort } from "@/lib/token-expiry";

export const dynamic = "force-dynamic";

/**
 * Firefly cURL (veya ham Bearer) → firefly_token.txt + arp/nonce/...
 * Tercih: F12 → generate-async / ingest → Copy as cURL (Windows curl.exe OK).
 */
export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  const raw = String(value || "").trim();
  if (!raw) {
    return NextResponse.json({ detail: "Curl / token boş" }, { status: 400 });
  }

  const extracted = extractFireflyCredsFromPaste(raw);
  try {
    const { token, saved } = persistFireflyCreds(extracted, CODE_ROOT);
    const rem = tokenExpRemaining(token);
    let expiryMsg: string | null = null;
    if (rem != null) {
      if (rem <= 0) expiryMsg = "SÜRESİ DOLMUŞ";
      else if (rem <= EXPIRY_WARN_SEC) expiryMsg = `⚠ ${formatRemainingShort(rem)} kaldı`;
      else expiryMsg = `geçerli, ${(rem / 3600).toFixed(1)}h kaldı`;
    }

    return NextResponse.json({
      ok: true,
      length: token.length,
      file: "firefly_token.txt",
      saved,
      from_curl: extracted.fromCurl,
      arp_saved: Boolean(extracted.arp),
      nonce_saved: Boolean(extracted.nonce),
      ua_saved: Boolean(extracted.userAgent),
      expiry: expiryMsg,
      detail: [
        `✓ ${saved.join(", ")}`,
        extracted.arp ? "arp✓" : "arp yok",
        extracted.nonce ? "nonce✓" : "nonce yok (her istekte taze üretilir)",
        expiryMsg,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  } catch (e) {
    return NextResponse.json(
      { detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
