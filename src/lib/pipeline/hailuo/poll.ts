import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { HAILUO_BASE } from "./constants";
import type { HailuoContext } from "./context";
import { getCookies, log } from "./context";
import { hlHeaders } from "./sign";

const POLL_INTERVAL = 15_000;
const POLL_TIMEOUT = 1_800_000;

const DETAIL_URL = `${HAILUO_BASE}/my-work-detail/ai-video/{vid}?source-page=create`;
const WO_RE =
  /downloadURLWithoutWatermark\\":\\"(https:\/\/cdn\.hailuoai\.video\/moss[^\\]+?\.mp4)/g;
const WM_RE =
  /downloadURLWithWatermark\\":\\"(https:\/\/cdn\.hailuoai\.video\/moss[^\\]+?\.mp4)/g;

function extractUrl(html: string, vidId: string): { url: string | null; label: string | null } {
  const vids: number[] = [];
  let m: RegExpExecArray | null;
  const vidRe = new RegExp(vidId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  while ((m = vidRe.exec(html))) vids.push(m.index);
  if (!vids.length) return { url: null, label: null };

  for (const [rex, label] of [
    [WO_RE, "watermarksiz"],
    [WM_RE, "watermarkli"],
  ] as const) {
    const cands: { pos: number; url: string }[] = [];
    rex.lastIndex = 0;
    while ((m = rex.exec(html))) {
      cands.push({ pos: m.index, url: m[1] });
    }
    let best: string | null = null;
    let bestD: number | null = null;
    for (const vpos of vids) {
      for (const { pos, url } of cands) {
        const d = pos - vpos;
        if (d >= 0 && d <= 3000 && (bestD === null || d < bestD)) {
          bestD = d;
          best = url;
        }
      }
    }
    if (best) return { url: best, label };
  }
  return { url: null, label: null };
}

export async function downloadStream(url: string, outPath: string): Promise<string> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
  const nodeStream = Readable.fromWeb(r.body as import("stream/web").ReadableStream);
  await pipeline(nodeStream, fs.createWriteStream(outPath));
  return outPath;
}

export async function pollDownload(
  vidId: string,
  token: string,
  ctx: HailuoContext,
  outPath: string,
): Promise<string> {
  const start = Date.now();
  const headers = {
    ...hlHeaders(token, ctx.projectId, "", getCookies(ctx)),
    Accept: "text/html,application/xhtml+xml",
  };

  while (Date.now() - start < POLL_TIMEOUT) {
    try {
      const r = await fetch(DETAIL_URL.replace("{vid}", vidId), { headers });
      if (r.status === 401 || r.status === 403) {
        throw new Error("Hailuo token süresi dolmuş (poll)");
      }
      if (!r.ok) throw new Error(`poll HTTP ${r.status}`);
      const html = await r.text();
      const { url, label } = extractUrl(html, vidId);
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (url) {
        log(`   [${String(elapsed).padStart(3)}s] HAZIR (${label}): ...${url.slice(-60)}`);
        return downloadStream(url, outPath);
      }
      log(`   [${String(elapsed).padStart(3)}s] henüz hazır değil`);
    } catch (e) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      log(`   [${String(elapsed).padStart(3)}s] poll hatası: ${e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error("Hailuo poll ZAMAN AŞIMI");
}

export function normalizePrompt(prompt: string): string {
  return (prompt || "").replace(/^\[([^\]]+)\]/, (_, inner: string) => {
    return `[${inner.replace(/, /g, ",")}]`;
  });
}
