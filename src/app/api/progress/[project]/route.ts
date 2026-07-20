import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";
import { readKeyframesSource } from "@/lib/ingest";
import { resolveRouterPaths } from "@/lib/pipeline/router/resolve";
import { pidAlive, readRunstate } from "@/lib/runstate";

export const dynamic = "force-dynamic";

const WARN_TAGS = ["[UYARI", "[S4", "[ALAN", "[DOGRULAMA", "BASARISIZ", "2400001", "2400002"];

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ project: string }> },
) {
  const { project: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }

  const counts = { done: 0, submitted: 0, error: 0, other: 0 };
  const producing: string[] = [];
  const softened: { scene: string; attempt?: number }[] = [];
  const errors: { scene: string; error: string }[] = [];

  const rs = readRunstate();
  const provider =
    rs?.project === project && rs.provider ? rs.provider : "hailuo";
  const kfSource = readKeyframesSource(proj);
  const paths = resolveRouterPaths(provider, proj, kfSource);
  const progFiles = [paths.progressFile];
  if (provider === "hailuo") {
    const ffProg = resolveRouterPaths("firefly", proj, kfSource).progressFile;
    if (ffProg !== paths.progressFile) progFiles.push(ffProg);
  }

  for (const progFile of progFiles) {
    if (!fs.existsSync(progFile)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(progFile, "utf8")) as Record<string, Record<string, unknown>>;
      for (const [k, v] of Object.entries(d)) {
        const st = String(v.status || "").toLowerCase();
        const scene = String(v.scene || k);
        if (st === "done") counts.done += 1;
        else if (st === "submitted") {
          counts.submitted += 1;
          producing.push(scene);
        } else if (st === "error" || st === "failed") {
          counts.error += 1;
          errors.push({ scene, error: String(v.error || "").slice(0, 120) });
        } else counts.other += 1;
        if (v.softened) softened.push({ scene, attempt: v.soften_attempt as number | undefined });
      }
    } catch {
      /* */
    }
  }

  const warnings: string[] = [];
  const logf = path.join(proj, ".l2_run.log");
  if (fs.existsSync(logf)) {
    for (const line of fs.readFileSync(logf, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (WARN_TAGS.some((t) => s.includes(t))) warnings.push(s);
    }
  }

  let phase: string | null = null;
  let alive = false;
  let runError: string | null = null;
  if (rs && rs.project === project) {
    phase = rs.status || null;
    alive = pidAlive(rs.pid);
    runError = rs.error ? String(rs.error) : null;
  }

  let logTail: string[] = [];
  if (fs.existsSync(logf)) {
    const lines = fs.readFileSync(logf, "utf8").split(/\r?\n/).filter(Boolean);
    logTail = lines.slice(-12);
  }

  if (runError === "prompt rc=1") {
    runError = "Prompt üretimi başarısız — GEMINI_API_KEY gerekli (Senaryo B) veya Gemini/ffmpeg hatası";
  }

  return NextResponse.json({
    project,
    provider,
    phase,
    alive,
    error: runError,
    log_tail: logTail,
    counts,
    producing,
    softened,
    errors,
    warnings: warnings.slice(-15),
    runtime: "local",
  });
}
