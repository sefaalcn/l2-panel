import { NextResponse } from "next/server";
import { sendTelegram, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    return NextResponse.json(
      { ok: false, detail: "TELEGRAM_BOT_TOKEN yok — .env.local dosyasına ekleyin" },
      { status: 400 },
    );
  }
  if (!process.env.TELEGRAM_CHAT_ID?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        detail:
          "TELEGRAM_CHAT_ID yok — Telegram'da bota /start yazın, sonra tarayıcıda şu adresi açın: https://api.telegram.org/bot<TOKEN>/getUpdates — \"chat\":{\"id\":123456789} değerini .env.local içine TELEGRAM_CHAT_ID= olarak yapıştırın",
      },
      { status: 400 },
    );
  }
  if (!telegramConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        detail:
          "Telegram yapılandırılmamış — .env.local içine TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID ekleyin",
      },
      { status: 400 },
    );
  }

  const ok = await sendTelegram("L2.5 test — Telegram bildirimi çalışıyor ✓");
  return NextResponse.json({ ok, sent: ok });
}

export async function GET() {
  if (!telegramConfigured()) {
    return NextResponse.json({
      configured: false,
      detail: "TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik — .env.local kontrol edin, npm run dev yeniden başlatın",
    });
  }
  const ok = await sendTelegram("L2.5 test — Telegram bildirimi çalışıyor ✓");
  return NextResponse.json({ configured: true, sent: ok, chat_id: process.env.TELEGRAM_CHAT_ID?.trim() });
}
