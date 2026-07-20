import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { CODE_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

/** F12 → Cookie header → hailuo_cookie.txt (proje kökü) */
export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  const v = (value || "").replace(/^Cookie:\s*/i, "").trim();
  if (!v) {
    return NextResponse.json({ detail: "Cookie boş" }, { status: 400 });
  }
  if (v.length < 20) {
    return NextResponse.json({ detail: "Cookie çok kısa — F12 Request Headers → Cookie satırının tamamını kopyala" }, { status: 400 });
  }

  const fpath = path.join(CODE_ROOT, "hailuo_cookie.txt");
  fs.writeFileSync(fpath, v, "utf8");

  return NextResponse.json({ ok: true, path: "hailuo_cookie.txt", length: v.length });
}
