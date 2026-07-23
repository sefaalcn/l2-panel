/** Kimlik doğrulama hatalarını kullanıcıya hangi servis/token olduğunu söyleyerek açıklar */
export function formatAuthError(raw: string): string {
  const msg = String(raw || "").trim();
  if (!msg) return msg;

  const lower = msg.toLowerCase();

  if (lower.includes("firefly token") || lower.includes("firefly yetki")) return msg;

  if (
    lower.includes("hailuo token") ||
    (lower.includes("hailuo") && lower.includes("token"))
  ) {
    return msg.includes("Hailuo") ? msg : `Hailuo: ${msg}`;
  }

  if (lower.includes("401 = token süresi dolmuş") || lower.includes("401 = token")) {
    if (lower.includes("upload")) {
      return "Firefly Bearer token süresi dolmuş (görsel yükleme) — panelden Firefly Token yenile";
    }
    if (lower.includes("poll")) {
      return "Firefly Bearer token süresi dolmuş (sonuç bekleme) — panelden Firefly Token yenile";
    }
    return "Firefly Bearer token süresi dolmuş — panelden Firefly Token yenile";
  }

  if (lower.includes("403") && !lower.includes("hailuo")) {
    return "Firefly yetki hatası (403) — panelden Firefly Token yenile";
  }

  if (lower.includes("gemini") && (lower.includes("401") || lower.includes("403") || lower.includes("api key"))) {
    return "Gemini API anahtarı geçersiz veya süresi dolmuş — GEMINI_API_KEY yenile";
  }

  if (lower.includes("anthropic") && (lower.includes("401") || lower.includes("403"))) {
    return "Anthropic API anahtarı geçersiz — ANTHROPIC_API_KEY yenile";
  }

  if (lower.includes("cookie") && lower.includes("dol")) {
    return msg.includes("Hailuo") ? msg : `Hailuo Cookie süresi dolmuş — Cookie alanını yenile`;
  }

  if (lower.includes("kimlik/nonce")) {
    return "Kimlik hatası — Firefly ise Token, Hailuo ise Token+Cookie yenile";
  }

  return msg;
}

export function isAuthError(msg: string): boolean {
  const lower = String(msg || "").toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("token süresi") ||
    lower.includes("nonce") ||
    lower.includes("kimlik/nonce") ||
    lower.includes("cookie süresi") ||
    lower.includes("yetki hatası")
  );
}
