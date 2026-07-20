import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { CODE_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Firefly Bearer token → firefly_token.txt */
export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  let v = String(value || "").trim();
  if (!v) {
    return NextResponse.json({ detail: "Token boş" }, { status: 400 });
  }
  // "Bearer xxx" yapıştırılırsa sadece token kısmını sakla
  if (/^bearer\s+/i.test(v)) {
    v = v.replace(/^bearer\s+/i, "").trim();
  }
  if (v.length < 20) {
    return NextResponse.json({ detail: "Token çok kısa — Bearer değerinin tamamını yapıştır" }, { status: 400 });
  }

  const fpath = path.join(CODE_ROOT, "firefly_token.txt");
  fs.writeFileSync(fpath, v, "utf8");

  return NextResponse.json({ ok: true, length: v.length, file: "firefly_token.txt" });
}
