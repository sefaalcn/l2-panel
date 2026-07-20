import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { CODE_ROOT, PROJECTS_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Hailuo projectID → hailuo_project.txt (proje kökü; isteğe bağlı proje klasörü) */
export async function POST(req: Request) {
  const { value, project } = (await req.json()) as { value?: string; project?: string };
  const v = String(value || "").trim();
  if (!v) {
    return NextResponse.json({ detail: "Proje ID boş" }, { status: 400 });
  }
  if (!/^\d+$/.test(v)) {
    return NextResponse.json({ detail: "Proje ID yalnızca rakam olmalı" }, { status: 400 });
  }

  const written: string[] = [];
  const rootPath = path.join(CODE_ROOT, "hailuo_project.txt");
  fs.writeFileSync(rootPath, v, "utf8");
  written.push("hailuo_project.txt");

  const proj = String(project || "").trim();
  if (proj) {
    const dir = path.join(PROJECTS_ROOT, proj);
    if (fs.existsSync(dir)) {
      fs.writeFileSync(path.join(dir, "hailuo_project.txt"), v, "utf8");
      written.push(`projects/${proj}/hailuo_project.txt`);
    }
  }

  return NextResponse.json({ ok: true, value: v, written });
}
