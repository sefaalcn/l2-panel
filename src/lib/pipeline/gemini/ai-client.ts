import { GoogleGenAI } from "@google/genai";

/** Gemini Developer API — free vs paid key'in bağlı olduğu projeye göre belirlenir; client'ta force yok. */
export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

export function isFreeTierQuotaError(err: unknown): boolean {
  const s = String(err || "");
  return (
    /free_tier/i.test(s) ||
    /GenerateRequestsPerDayPerProjectPerModel-FreeTier/i.test(s) ||
    /GenerateContentInputTokensPerModelPerDay-FreeTier/i.test(s)
  );
}

export function formatGeminiQuotaHint(err: unknown): string {
  if (!isFreeTierQuotaError(err)) return "";
  return (
    "Gemini isteği FREE TIER kotasına düştü (limit: 0). " +
    "Billing hesabı yetmez — AI Studio'da PAID projeyi seçip o projeden yeni API key oluştur. " +
    "https://aistudio.google.com/api-keys  |  Projects → Billing/Tier kontrol"
  );
}
