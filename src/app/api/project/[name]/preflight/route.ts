import { NextResponse } from "next/server";
import { preflight } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  const d = preflight(decodeURIComponent(name));
  if (!d) return NextResponse.json({ detail: `Proje yok: ${name}` }, { status: 404 });
  return NextResponse.json(d);
}
