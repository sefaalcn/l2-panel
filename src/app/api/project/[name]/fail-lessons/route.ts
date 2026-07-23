import { NextResponse } from "next/server";
import { PROJECTS_ROOT } from "@/lib/config";
import fs from "fs";
import path from "path";
import {
  FAIL_TAGS,
  loadFailLessons,
  removeFailLessons,
  upsertFailLessons,
  type FailLessonItem,
  type FailTagKey,
} from "@/lib/fail-lessons";

export const dynamic = "force-dynamic";

function projPath(name: string) {
  return path.join(PROJECTS_ROOT, name);
}

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  if (!fs.existsSync(projPath(project))) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  const data = loadFailLessons(project);
  return NextResponse.json({ project, tags: FAIL_TAGS, ...data });
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  if (!fs.existsSync(projPath(project))) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    items?: Partial<FailLessonItem>[];
    files?: string[];
  };
  const action = body.action || "upsert";

  if (action === "remove") {
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    const data = removeFailLessons(project, files);
    return NextResponse.json({ project, tags: FAIL_TAGS, ...data });
  }

  const items = (body.items || []).map((it) => ({
    file: String(it.file || ""),
    scene: it.scene ?? null,
    variant: it.variant ?? null,
    tags: (it.tags || []) as FailTagKey[],
    note: it.note,
  }));
  const data = upsertFailLessons(project, items);
  return NextResponse.json({ project, tags: FAIL_TAGS, ...data });
}
