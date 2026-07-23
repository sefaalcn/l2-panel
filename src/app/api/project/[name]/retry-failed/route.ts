import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";
import { readKeyframesSource } from "@/lib/ingest";
import { resolveRouterPaths } from "@/lib/pipeline/router/resolve";
import { getActiveRun } from "@/lib/runstate";

export const dynamic = "force-dynamic";

const RETRY_STATUSES = new Set([
  "failed",
  "error",
  "no_input_frame",
]);

function sceneIndexFromKey(key: string, scene?: unknown): number | null {
  const fromScene = String(scene || "").match(/(\d+)/);
  if (fromScene) return Number(fromScene[1]);
  const fromKey = key.match(/scene[_\s-]?(\d+)/i) || key.match(/(\d{1,4})/);
  return fromKey ? Number(fromKey[1]) : null;
}

/** Başarısız progress kayıtlarını sil → aynı sahneler yeniden üretilebilir */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  const running = getActiveRun(project);
  if (running) {
    return NextResponse.json(
      { detail: `Koşu sürüyor (pid ${running.pid}) — önce Durdur` },
      { status: 409 },
    );
  }

  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }

  const hailuo = resolveRouterPaths("hailuo", proj, readKeyframesSource(proj));
  const firefly = resolveRouterPaths("firefly", proj, readKeyframesSource(proj));
  const files = [hailuo.progressFile, firefly.progressFile];
  const scenes = new Set<number>();
  let cleared = 0;
  const clearedFiles: string[] = [];

  for (const fpath of files) {
    if (!fs.existsSync(fpath)) continue;
    let data: Record<string, Record<string, unknown>>;
    try {
      data = JSON.parse(fs.readFileSync(fpath, "utf8"));
    } catch {
      continue;
    }
    let changed = false;
    for (const [k, v] of Object.entries(data)) {
      const st = String(v?.status || "").toLowerCase();
      if (!RETRY_STATUSES.has(st)) continue;
      const idx = sceneIndexFromKey(k, v?.scene);
      if (idx != null && Number.isFinite(idx)) scenes.add(idx);
      delete data[k];
      cleared += 1;
      clearedFiles.push(k);
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(fpath, JSON.stringify(data, null, 2), "utf8");
    }
  }

  const sceneList = [...scenes].sort((a, b) => a - b);
  if (!cleared) {
    return NextResponse.json({
      ok: true,
      cleared: 0,
      scenes: [],
      detail: "Yeniden denenecek hata kaydı yok",
    });
  }

  return NextResponse.json({
    ok: true,
    cleared,
    scenes: sceneList,
    files: clearedFiles.slice(0, 40),
    scenes_param: sceneList.join(","),
  });
}
