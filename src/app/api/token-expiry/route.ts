import { NextResponse } from "next/server";
import { expiryWarningMessage } from "@/lib/token-expiry";
import { watchProjectCredentialExpiries } from "@/lib/token-expiry-watch";
import { telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() || null;
  const notify = url.searchParams.get("notify") !== "0";
  const expiring = watchProjectCredentialExpiries(project, notify);

  return NextResponse.json({
    warn_within_min: 30,
    expiring: expiring.map((item) => ({
      ...item,
      message: expiryWarningMessage(item),
    })),
    telegram: telegramConfigured(),
  });
}
