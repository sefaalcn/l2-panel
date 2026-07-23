import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";
import { readKeyframesSource } from "@/lib/ingest";
import { resolveRouterPaths } from "@/lib/pipeline/router/resolve";
import { getActiveRun } from "@/lib/runstate";

export const dynamic = "force-dynamic";

type PromptRow = Record<string, unknown>;

function promptsPath(proj: string): string {
  return resolveRouterPaths("hailuo", proj, readKeyframesSource(proj)).promptsJson;
}

function loadScenes(fpath: string): PromptRow[] {
  const raw = JSON.parse(fs.readFileSync(fpath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.scenes)) return raw.scenes;
  throw new Error("prompts JSON dizi değil");
}

function sceneIndexFromKey(key: string): number | null {
  const m = key.match(/scene[_\s-]?(\d+)/i) || key.match(/(\d{1,4})/);
  return m ? Number(m[1]) : null;
}

function variantFromKey(key: string, fallback?: string | null): string {
  const m = key.match(/_(v[1-4])(?:\.|$)/i);
  if (m) return m[1].toLowerCase();
  return String(fallback || "v1").toLowerCase();
}

function clearProgressEntries(
  proj: string,
  sceneIdx: number,
  variant: string,
  failedKey?: string | null,
): number {
  const kf = readKeyframesSource(proj);
  const files = [
    resolveRouterPaths("hailuo", proj, kf).progressFile,
    resolveRouterPaths("firefly", proj, kf).progressFile,
  ];
  let cleared = 0;
  for (const fpath of [...new Set(files)]) {
    if (!fs.existsSync(fpath)) continue;
    let data: Record<string, Record<string, unknown>>;
    try {
      data = JSON.parse(fs.readFileSync(fpath, "utf8"));
    } catch {
      continue;
    }
    let changed = false;
    for (const [k, v] of Object.entries(data)) {
      if (failedKey && k === failedKey) {
        delete data[k];
        cleared += 1;
        changed = true;
        continue;
      }
      const idx =
        Number(v?.scene_index) ||
        sceneIndexFromKey(String(v?.scene || "")) ||
        sceneIndexFromKey(k);
      const varKey = String(v?.variant || variantFromKey(k) || "").toLowerCase();
      if (idx === sceneIdx && varKey === variant) {
        delete data[k];
        cleared += 1;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(fpath, JSON.stringify(data, null, 2), "utf8");
  }
  return cleared;
}

/** GET ?scene=4 — sahne promptlarını getir */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  const sceneQ = new URL(req.url).searchParams.get("scene");
  const sceneIdx = Number(sceneQ);
  if (!Number.isFinite(sceneIdx) || sceneIdx < 1) {
    return NextResponse.json({ detail: "scene=N gerekli" }, { status: 400 });
  }

  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }

  const fpath = promptsPath(proj);
  if (!fs.existsSync(fpath)) {
    return NextResponse.json({ detail: `Prompt JSON yok: ${path.basename(fpath)}` }, { status: 404 });
  }

  try {
    const scenes = loadScenes(fpath);
    const row = scenes.find((s) => Number(s.index) === sceneIdx);
    if (!row) {
      return NextResponse.json({ detail: `Sahne ${sceneIdx} prompt JSON'da yok` }, { status: 404 });
    }
    return NextResponse.json({
      project,
      index: sceneIdx,
      label: String(row.label || `scene_${String(sceneIdx).padStart(3, "0")}`),
      prompts: {
        v1: String(row.v1 || ""),
        v2: String(row.v2 || ""),
        v3: String(row.v3 || row.scene_desc || ""),
        v4: String(row.v4 || ""),
        scene_desc: String(row.scene_desc || ""),
      },
    });
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 });
  }
}

/**
 * POST — promptu kaydet + progress temizle; panel start ile yeniden gönderir.
 * body: { scene, prompt, variant: "default"|"v1"|"v2"|"v3"|"v4", failedKey?, failedVariant? }
 */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  const running = getActiveRun(project);
  if (running) {
    return NextResponse.json(
      { detail: `Koşu sürüyor (pid ${running.pid}) — önce Durdur` },
      { status: 409 },
    );
  }

  const body = (await req.json()) as {
    scene?: number | string;
    prompt?: string;
    variant?: string;
    failedKey?: string;
    failedVariant?: string;
  };

  const sceneIdx = Number(body.scene);
  const prompt = String(body.prompt || "").trim();
  if (!Number.isFinite(sceneIdx) || sceneIdx < 1) {
    return NextResponse.json({ detail: "scene gerekli" }, { status: 400 });
  }
  if (prompt.length < 8) {
    return NextResponse.json({ detail: "prompt çok kısa" }, { status: 400 });
  }

  let targetVariant = String(body.variant || "default").toLowerCase();
  if (targetVariant === "default") {
    targetVariant = String(
      body.failedVariant ||
        (body.failedKey ? variantFromKey(body.failedKey) : "") ||
        "v1",
    ).toLowerCase();
  }
  if (!/^v[1-4]$/.test(targetVariant)) {
    return NextResponse.json({ detail: "variant: default|v1|v2|v3|v4" }, { status: 400 });
  }

  const proj = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(proj)) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }

  const fpath = promptsPath(proj);
  if (!fs.existsSync(fpath)) {
    return NextResponse.json({ detail: `Prompt JSON yok` }, { status: 404 });
  }

  try {
    const scenes = loadScenes(fpath);
    const row = scenes.find((s) => Number(s.index) === sceneIdx);
    if (!row) {
      return NextResponse.json({ detail: `Sahne ${sceneIdx} yok` }, { status: 404 });
    }
    row[targetVariant] = prompt;
    fs.writeFileSync(fpath, JSON.stringify(scenes, null, 2), "utf8");

    const cleared = clearProgressEntries(proj, sceneIdx, targetVariant, body.failedKey);

    // Eski mp4 varsa yeniden üretim için sil
    const kf = readKeyframesSource(proj);
    for (const provider of ["hailuo", "firefly"] as const) {
      const { videoDir } = resolveRouterPaths(provider, proj, kf);
      if (!fs.existsSync(videoDir)) continue;
      for (const name of fs.readdirSync(videoDir)) {
        if (!name.endsWith(".mp4")) continue;
        const idx = sceneIndexFromKey(name);
        const v = variantFromKey(name);
        if (idx === sceneIdx && v === targetVariant) {
          try {
            fs.unlinkSync(path.join(videoDir, name));
          } catch {
            /* kilitli olabilir */
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      scene: sceneIdx,
      variant: targetVariant,
      cleared,
      scenes_param: String(sceneIdx),
      variants: targetVariant,
    });
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 });
  }
}
