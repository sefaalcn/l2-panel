import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "stream";
import AdmZip from "adm-zip";
import { listProjectOutputs, resolveOutputFile } from "@/lib/outputs";

export const dynamic = "force-dynamic";

function streamFile(filePath: string, downloadName: string) {
  const stat = fs.statSync(filePath);
  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;
  return new NextResponse(webStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  const url = new URL(req.url);
  const file = decodeURIComponent(url.searchParams.get("file") || "");
  const zipAll = url.searchParams.get("zip") === "1";
  const provider = url.searchParams.get("provider");

  if (zipAll) {
    const { files } = listProjectOutputs(project, provider);
    if (!files.length) {
      return NextResponse.json({ detail: "İndirilecek video yok" }, { status: 404 });
    }
    const zip = new AdmZip();
    for (const f of files) {
      const fp = resolveOutputFile(project, f.name, provider);
      if (fp) zip.addLocalFile(fp, "", f.name);
    }
    const buf = zip.toBuffer();
    const zipName = `${project.replace(/[^\w\-+. ]/g, "_")}_videos.zip`;
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(buf.length),
        "Content-Disposition": `attachment; filename="${zipName}"`,
      },
    });
  }

  if (!file) {
    return NextResponse.json({ detail: "file veya zip=1 gerekli" }, { status: 400 });
  }

  const fp = resolveOutputFile(project, file, provider);
  if (!fp) {
    return NextResponse.json({ detail: "Dosya bulunamadı" }, { status: 404 });
  }

  return streamFile(fp, path.basename(fp));
}
