import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { materializeExport, parseKeyframesSource } from "@/lib/ingest";
import { PROJECTS_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

function ensureProjectsWritable(): string | null {
  try {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
    const probe = path.join(PROJECTS_ROOT, ".write_probe");
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `projects/ yazılamıyor (${msg}) — Vercel'de dosya yükleme desteklenmez, localhost kullanın`;
  }
}

export async function POST(req: Request) {
  try {
    const diskErr = ensureProjectsWritable();
    if (diskErr) {
      return NextResponse.json({ detail: diskErr }, { status: 503 });
    }

    const expected = (process.env.L2_INGEST_TOKEN || "").trim();
    if (expected) {
      const h = req.headers.get("x-l2-ingest-token") || "";
      const auth = req.headers.get("authorization") || "";
      const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      if (h !== expected && bearer !== expected) {
        return NextResponse.json({ detail: "ingest token geçersiz" }, { status: 401 });
      }
    }

    const form = await req.formData();
    const project = String(form.get("project") || "").trim();
    const scenes = form.get("scenes");
    const zip = form.get("keyframes_zip");
    const video = form.get("video");
    const keyframesSource = parseKeyframesSource(form.get("keyframes_source"));
    if (!project || !(scenes instanceof File) || !(zip instanceof File)) {
      return NextResponse.json({ detail: "project, scenes, keyframes_zip gerekli" }, { status: 400 });
    }

    const scenesBytes = Buffer.from(await scenes.arrayBuffer());
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    let videoBytes: Buffer | null = null;
    let videoName: string | null = null;
    if (video instanceof File && video.size > 0) {
      videoBytes = Buffer.from(await video.arrayBuffer());
      videoName = video.name;
    }

    const info = materializeExport({
      project,
      scenesBytes,
      zipBytes,
      videoBytes,
      videoName,
      keyframesSource,
    });

    return NextResponse.json({
      ok: true,
      runtime: "local",
      project: info.project,
      path: info.path,
      keyframes_source: info.keyframes_source,
      has_keyframes: info.has_keyframes,
      video: info.video,
      extracted: info.extracted,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ingest]", msg, e);
    const isFormData = /formdata|boundary|body/i.test(msg);
    return NextResponse.json(
      {
        detail: isFormData
          ? `Yükleme parse hatası (dosya çok büyük olabilir): ${msg}`
          : msg,
      },
      { status: 500 },
    );
  }
}
