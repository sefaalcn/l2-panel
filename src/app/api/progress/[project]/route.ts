import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";
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

  const progFile = path.join(proj, "hailuo_router_progress.json");
  if (fs.existsSync(progFile)) {
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
  const rs = readRunstate();
  if (rs && rs.project === project) {
    phase = rs.status || null;
    alive = pidAlive(rs.pid);
  }

  return NextResponse.json({
    project,
    phase,
    alive,
    counts,
    producing,
    softened,
    errors,
    warnings: warnings.slice(-15),
    runtime: "local",
  });
}
