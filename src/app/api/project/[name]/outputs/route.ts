import { NextResponse } from "next/server";
import { formatBytes, listProjectOutputs, outputFolderLabel } from "@/lib/outputs";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  const provider = new URL(req.url).searchParams.get("provider");
  const { dir, files, provider: prov } = listProjectOutputs(project, provider);
  if (dir === null) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  return NextResponse.json({
    project,
    provider: prov,
    output_folder: outputFolderLabel(prov),
    dir,
    count: files.length,
    files: files.map((f) => ({
      ...f,
      size_label: formatBytes(f.size),
      download_url: `/api/project/${encodeURIComponent(project)}/download?file=${encodeURIComponent(f.name)}&provider=${encodeURIComponent(prov)}`,
    })),
  });
}
