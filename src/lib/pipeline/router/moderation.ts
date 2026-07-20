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

const SYSTEM = [
  "Bir video-uretim promptu icerik moderasyonuna takildi. Gorevin: AYNI sahneyi ve AYNI eylemi ",
  "koruyarak, moderasyona takilabilecek terimleri (tibbi: igne/asi/enjeksiyon; siddet; vb.) ",
  "yumusatmak. Kamera/aksiyon/stil etiketlerini koru. Her denemede biraz DAHA yumusak yaz. ",
  "SADECE yeni promptu don, aciklama yazma.",
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
