import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { PROJECTS_ROOT } from "@/lib/config";
import { readKeyframesSource } from "@/lib/ingest";
import { resolveRouterPaths } from "@/lib/pipeline/router/resolve";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const project = String(body.project || "").trim();
  const target = String(body.target || "videos");
  const provider = String(body.provider || "hailuo");
  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  let folder = proj;
  if (target === "videos") {
    const kfSource = readKeyframesSource(proj);
    folder = resolveRouterPaths(provider, proj, kfSource).outputDir;
  }
  if (!fs.existsSync(folder)) folder = proj;

  const cmd =
    process.platform === "win32"
      ? `explorer "${folder}"`
      : process.platform === "darwin"
        ? `open "${folder}"`
        : `xdg-open "${folder}"`;
  exec(cmd);
  return NextResponse.json({ opened: folder, runtime: "local" });
}
