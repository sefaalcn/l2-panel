import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { CODE_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Hailuo projectID → hailuo_project.txt (proje kökü) */
export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  const v = String(value || "").trim();
  if (!v) {
    return NextResponse.json({ detail: "Proje ID boş" }, { status: 400 });
  }

  const fpath = path.join(CODE_ROOT, "hailuo_project.txt");
  fs.writeFileSync(fpath, v, "utf8");

  return NextResponse.json({ ok: true, path: "hailuo_project.txt", length: v.length });
}
