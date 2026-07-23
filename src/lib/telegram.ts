import { formatAuthError } from "./auth-errors";
import { formatRemainingShort } from "./token-expiry";

const DEDUPE = new Map<string, number>();
const DEDUPE_TTL_MS = 5 * 60 * 1000;

export type TelegramNotifyKind =
  | "run_start"
  | "run_done"
  | "run_error"
  | "auth_error"
  | "worker_died"
  | "token_expiring";

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
}

function shouldSend(key: string): boolean {
  const now = Date.now();
  const prev = DEDUPE.get(key);
  if (prev && now - prev < DEDUPE_TTL_MS) return false;
  DEDUPE.set(key, now);
  return true;
}

export async function sendTelegram(
  text: string,
  opts?: { dedupeKey?: string; silent?: boolean },
): Promise<boolean> {
  if (!telegramConfigured()) return false;
  if (opts?.dedupeKey && !shouldSend(opts.dedupeKey)) return false;

  const token = process.env.TELEGRAM_BOT_TOKEN!.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID!.trim();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        disable_notification: opts?.silent === true,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function notifyPipeline(
  kind: TelegramNotifyKind,
  details: { project: string; message?: string; provider?: string },
) {
  if (!telegramConfigured()) return;

  const icons: Record<TelegramNotifyKind, string> = {
    run_start: "▶️",
    run_done: "✅",
    run_error: "❌",
    auth_error: "🔐",
    worker_died: "💀",
    token_expiring: "⏳",
  };
  const titles: Record<TelegramNotifyKind, string> = {
    run_start: "Üretim başladı",
    run_done: "Üretim tamamlandı",
    run_error: "Üretim hatası",
    auth_error: "Token / kimlik hatası",
    worker_died: "Worker beklenmedik durdu",
    token_expiring: "Token süresi bitiyor",
  };

  const lines = [`${icons[kind]} L2.5 — ${titles[kind]}`, `Proje: ${details.project}`];
  if (details.provider) lines.push(`Motor: ${details.provider}`);
  if (details.message) lines.push(formatAuthError(details.message));

  const dedupeKey = `${kind}:${details.project}:${details.message?.slice(0, 120) || ""}`;
  await sendTelegram(lines.join("\n"), { dedupeKey });
}

export async function notifyTokenExpiring(details: {
  project: string;
  label: string;
  remainingSec: number;
  message: string;
}) {
  if (!telegramConfigured()) return;

  const lines = [
    `⏳ L2.5 — Token süresi bitiyor`,
    `Proje: ${details.project}`,
    details.message,
    `Kalan: ${formatRemainingShort(details.remainingSec)}`,
  ];
  const dedupeKey = `token_expiring:${details.label}:${Math.floor(details.remainingSec / 300)}`;
  await sendTelegram(lines.join("\n"), { dedupeKey });
}
