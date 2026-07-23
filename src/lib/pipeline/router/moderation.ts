import { resolveApiKey } from "@/lib/api-keys";
import { createGeminiClient } from "@/lib/pipeline/gemini/ai-client";
import { GEMINI_MODEL } from "@/lib/pipeline/gemini/prompts";

const OPUS_MODEL = "claude-opus-4-8";

export type ErrorKind = "moderation" | "structural" | "other";

export function classify(exc: unknown): ErrorKind {
  const s = String(exc);
  if (s.includes("2400001")) return "structural";
  if (s.includes("2400002")) return "moderation";
  if (s.includes("HTTP 451") || s.includes("451 Client Error")) return "moderation";
  return "other";
}

export function moderationAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env.ANTHROPIC_API_KEY || "").trim());
}

export function geminiModerationAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Boolean(resolveApiKey("GEMINI_API_KEY", env));
  } catch {
    return false;
  }
}

const SYSTEM = [
  "Bir video-uretim promptu icerik moderasyonuna takildi. Gorevin: AYNI sahneyi ve AYNI eylemi ",
  "koruyarak, moderasyona takilabilecek terimleri (tibbi: igne/asi/enjeksiyon; siddet; vb.) ",
  "yumusatmak. Kamera/aksiyon/stil etiketlerini koru. Her denemede biraz DAHA yumusak yaz. ",
  "SADECE yeni promptu don, aciklama yazma.",
].join("");

const GEMINI_SOFTEN_SYSTEM = [
  "You rewrite a video-generation prompt that failed content moderation. ",
  "Keep the SAME scene, action, camera and style tags. ",
  "Replace real-infant/child wording with stylized cartoon language: ",
  "baby→baby character / toddler character; kid/child→child character; infant→small character. ",
  "Avoid medical, violence, and sensitive body terms. ",
  "Return ONLY the new English prompt, no quotes or explanation.",
].join("");

export async function soften(
  original: string,
  attempt: number,
  prior: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const key = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY yok — yumuşatma yapılamaz.");

  let priorTxt = "";
  if (prior.length) {
    priorTxt =
      "\n\nBu denemeler de takildi, daha da yumusak yaz:\n" +
      prior.map((p) => `  - ${p}`).join("\n");
  }
  const user = `Orijinal prompt (takildi):\n${original}${priorTxt}\n\nYumusatma denemesi #${attempt}. Yeni promptu yaz:`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic soften ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { content?: { text?: string }[] };
  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error("Anthropic soften: boş yanıt");
  return text;
}

/** Moderasyon sonrası 1 tur Gemini yumuşatma (baby → baby character vb.). */
export async function softenWithGemini(
  original: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const key = resolveApiKey("GEMINI_API_KEY", env);
  if (!key) throw new Error("GEMINI_API_KEY yok — Gemini yumuşatma yapılamaz.");

  const client = createGeminiClient(key);
  const resp = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `${GEMINI_SOFTEN_SYSTEM}\n\n` +
              `Original prompt (blocked):\n${original}\n\nRewritten prompt:`,
          },
        ],
      },
    ],
    config: { temperature: 0.4, maxOutputTokens: 800 },
  });
  const text = String(resp.text || "").trim().replace(/^["']|["']$/g, "");
  if (!text) throw new Error("Gemini soften: boş yanıt");
  return text;
}
