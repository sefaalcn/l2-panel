import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { formatAuthError } from "@/lib/auth-errors";
import { notifyPipeline } from "@/lib/telegram";
import { expiryWarningMessage } from "@/lib/token-expiry";
import { watchProjectCredentialExpiries } from "@/lib/token-expiry-watch";
import { PROJECTS_ROOT } from "@/lib/config";
import { readKeyframesSource } from "@/lib/ingest";
import { resolveRouterPaths } from "@/lib/pipeline/router/resolve";
import { pidAlive, readRunstate, clearRunstate } from "@/lib/runstate";

export const dynamic = "force-dynamic";

const WARN_TAGS = ["[UYARI", "[S4", "[ALAN", "[DOGRULAMA", "BASARISIZ", "2400001", "2400002"];

function safePercent(current: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const raw = Math.floor((current / total) * 100);
  return Math.max(0, Math.min(100, raw));
}

function countScenesJson(projectDir: string): number {
  try {
    const file = fs
      .readdirSync(projectDir)
      .filter(
        (n) =>
          n.toLowerCase().endsWith(".json") &&
          (n.includes("_scenes_manual") || n.toLowerCase().includes("scenes")) &&
          !n.toLowerCase().includes("progress"),
      )
      .sort((a, b) => (a.includes("_scenes_manual") ? -1 : b.includes("_scenes_manual") ? 1 : 0))[0];
    if (!file) return 0;
    const raw = JSON.parse(fs.readFileSync(path.join(projectDir, file), "utf8"));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.scenes) ? raw.scenes : [];
    return arr.length;
  } catch {
    return 0;
  }
}

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
  const producing: { id: string; label: string }[] = [];
  const softened: { scene: string; attempt?: number }[] = [];
  const errors: {
    id: string;
    scene: string;
    error: string;
    variant?: string;
    prompt?: string;
    scene_index?: number | null;
  }[] = [];

  const rs = readRunstate(project);
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
          const variant = v.variant ? String(v.variant) : "";
          producing.push({
            id: k,
            label: variant ? `${scene} · ${variant}` : scene,
          });
        } else if (st === "error" || st === "failed" || st === "no_input_frame") {
          counts.error += 1;
          const variant = v.variant ? String(v.variant) : "";
          const prompt = v.prompt ? String(v.prompt) : "";
          const scene_index =
            typeof v.scene_index === "number"
              ? v.scene_index
              : Number(String(scene).match(/(\d+)/)?.[1] || NaN) || null;
          errors.push({
            id: k,
            scene,
            error: formatAuthError(String(v.error || v.status || "")).slice(0, 200),
            variant: variant || undefined,
            prompt: prompt || undefined,
            scene_index,
          });
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
    if (!alive && phase && !["bitti", "hata", "durduruldu"].includes(phase)) {
      phase = "hata";
      runError =
        runError ||
        "Worker durdu (beklenmedik) — .l2_run.log dosyasına bakın veya panelden Durdur ile temizleyin";
      notifyPipeline("worker_died", { project, message: runError });
      clearRunstate(project);
    }
  }

  let logTail: string[] = [];
  if (fs.existsSync(logf)) {
    const lines = fs.readFileSync(logf, "utf8").split(/\r?\n/).filter(Boolean);
    logTail = lines.slice(-12);
  }

  if (runError === "prompt rc=1") {
    runError = "Prompt üretimi başarısız — GEMINI_API_KEY gerekli (Senaryo B) veya Gemini/ffmpeg hatası";
  } else if (runError) {
    runError = formatAuthError(runError);
  }

  let expiringSoon: { id: string; label: string; remainingSec: number; message: string }[] = [];
  if (alive && phase && !["bitti", "hata", "durduruldu", null].includes(phase)) {
    expiringSoon = watchProjectCredentialExpiries(project, true).map((item) => ({
      ...item,
      message: expiryWarningMessage(item),
    }));
  }

  const videoTotal = counts.done + counts.submitted + counts.error + counts.other;
  const videoCurrent = counts.done + counts.submitted + counts.error;
  let promptTotal = 0;
  let promptCurrent = 0;
  if (fs.existsSync(paths.promptsJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(paths.promptsJson, "utf8"));
      const arr = Array.isArray(data) ? data : Array.isArray(data?.scenes) ? data.scenes : [];
      promptCurrent = arr.length;
    } catch {
      /* */
    }
  }
  promptTotal = countScenesJson(proj);

  const progress_meta = {
    prompt: {
      current: promptCurrent,
      total: promptTotal,
      percent: safePercent(promptCurrent, promptTotal),
    },
    video: {
      current: videoCurrent,
      total: videoTotal,
      percent: safePercent(videoCurrent, videoTotal),
    },
  };

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
    expiring_soon: expiringSoon,
    progress_meta,
    runtime: "local",
  });
}
