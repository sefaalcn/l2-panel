import { NextResponse } from "next/server";
import { PROJECTS_ROOT } from "@/lib/config";
import { telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    runtime: "next",
    ingest: true,
    projects_root: PROJECTS_ROOT,
    drive_sync: Boolean(process.env.L2_PROJECTS_ROOT),
    telegram: telegramConfigured(),
  });
}
