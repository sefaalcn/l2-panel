import { NextResponse } from "next/server";
import { parseKeyframesSource } from "@/lib/ingest";
import { preflight } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  const url = new URL(req.url);
  const src = url.searchParams.get("keyframes_source");
  const d = preflight(
    decodeURIComponent(name),
    src ? parseKeyframesSource(src) : null,
  );
  if (!d) return NextResponse.json({ detail: `Proje yok: ${name}` }, { status: 404 });
  return NextResponse.json(d);
}
