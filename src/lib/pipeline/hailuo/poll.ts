import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { HAILUO_BASE } from "./constants";
import type { HailuoContext } from "./context";
import { getCookies, log } from "./context";
import { pollFeedForDownload, pollVideoResultApi } from "./api";
import { hlHeaders } from "./sign";

const POLL_INTERVAL = 15_000;
/** Low-speed modda 30+ dk sürebilir */
const POLL_TIMEOUT = 3_600_000;

const DETAIL_URL = `${HAILUO_BASE}/my-work-detail/ai-video/{vid}?source-page=create`;

const MP4_CDN = /https:\/\/cdn\.hailuoai\.video\/moss[^\s"'\\]+?\.mp4/g;

const LEGACY_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /downloadURLWithoutWatermark\\":\\"(https:\/\/cdn\.hailuoai\.video\/moss[^\\]+?\.mp4)/g,
    label: "watermarksiz",
  },
  {
    re: /downloadURLWithWatermark\\":\\"(https:\/\/cdn\.hailuoai\.video\/moss[^\\]+?\.mp4)/g,
    label: "watermarkli",
  },
  {
    re: /"downloadURLWithoutWatermark"\s*:\s*"(https:\/\/cdn\.hailuoai\.video\/moss[^"]+?\.mp4)"/g,
    label: "watermarksiz",
  },
  {
    re: /"downloadURLWithWatermark"\s*:\s*"(https:\/\/cdn\.hailuoai\.video\/moss[^"]+?\.mp4)"/g,
    label: "watermarkli",
  },
];

function decodeMp4Url(raw: string): string {
  return raw.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
}

function nearestUrl(
  html: string,
  vidId: string,
  cands: { pos: number; url: string }[],
): string | null {
  const vids: number[] = [];
  const vidRe = new RegExp(vidId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  let m: RegExpExecArray | null;
  while ((m = vidRe.exec(html))) vids.push(m.index);
  if (!vids.length) return null;

  let best: string | null = null;
  let bestD: number | null = null;
  for (const vpos of vids) {
    for (const { pos, url } of cands) {
      const d = Math.abs(pos - vpos);
      if (d <= 8000 && (bestD === null || d < bestD)) {
        bestD = d;
        best = url;
      }
    }
  }
  return best;
}

function deepFindDownloadUrl(obj: unknown, vidId: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFindDownloadUrl(item, vidId);
      if (hit) return hit;
    }
    return null;
  }
  const o = obj as Record<string, unknown>;
  const id = String(o.id ?? o.videoID ?? o.videoId ?? o.video_id ?? "");
  if (id === vidId) {
    for (const key of [
      "downloadURLWithoutWatermark",
      "downloadURLWithWatermark",
      "downloadUrl",
      "videoUrl",
      "url",
    ]) {
      const v = o[key];
      if (typeof v === "string" && v.includes(".mp4")) return decodeMp4Url(v);
    }
  }
  for (const v of Object.values(o)) {
    const hit = deepFindDownloadUrl(v, vidId);
    if (hit) return hit;
  }
  return null;
}

function extractFromNextData(html: string, vidId: string): string | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return deepFindDownloadUrl(JSON.parse(m[1]), vidId);
  } catch {
    return null;
  }
}

function extractUrl(html: string, vidId: string): { url: string | null; label: string | null } {
  for (const { re, label } of LEGACY_PATTERNS) {
    const cands: { pos: number; url: string }[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      cands.push({ pos: m.index, url: decodeMp4Url(m[1]) });
    }
    const best = nearestUrl(html, vidId, cands);
    if (best) return { url: best, label };
  }

  const jsonHit = extractFromNextData(html, vidId);
  if (jsonHit) return { url: jsonHit, label: "json" };

  const deepHit = deepFindDownloadUrl(
    (() => {
      try {
        return JSON.parse(html);
      } catch {
        return null;
      }
    })(),
    vidId,
  );
  if (deepHit) return { url: deepHit, label: "json" };

  if (html.includes(vidId)) {
    const cands: { pos: number; url: string }[] = [];
    MP4_CDN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MP4_CDN.exec(html))) {
      cands.push({ pos: m.index, url: decodeMp4Url(m[0]) });
    }
    const best = nearestUrl(html, vidId, cands);
    if (best) return { url: best, label: "cdn-yakın" };
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
  let missingVidWarned = false;

  while (Date.now() - start < POLL_TIMEOUT) {
    try {
      let apiStatus = "";
      try {
        const apiHit = await pollVideoResultApi(vidId, token, ctx);
        apiStatus = apiHit.status || "";
        if (apiHit.url) {
          const elapsed = Math.floor((Date.now() - start) / 1000);
          log(
            `   [${String(elapsed).padStart(3)}s] HAZIR (result-api, status=${apiStatus || "?"}): ...${apiHit.url.slice(-60)}`,
          );
          return downloadStream(apiHit.url, outPath);
        }
      } catch (e) {
        // token süresi dolmuş vb. — yukarı fırlat; diğer soft hatalar feed/HTML'e düşer
        if (String(e).includes("token süresi dolmuş")) throw e;
        apiStatus = "result_err";
      }

      const feedUrl = await pollFeedForDownload(vidId, token, ctx);
      if (feedUrl) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        log(`   [${String(elapsed).padStart(3)}s] HAZIR (feed-api): ...${feedUrl.slice(-60)}`);
        return downloadStream(feedUrl, outPath);
      }

      const r = await fetch(DETAIL_URL.replace("{vid}", vidId), { headers });
      if (r.status === 401 || r.status === 403) {
        throw new Error("Hailuo token süresi dolmuş (poll) — token/cookie yenile");
      }
      if (!r.ok) throw new Error(`poll HTTP ${r.status}`);
      const html = await r.text();
      const elapsed = Math.floor((Date.now() - start) / 1000);

      if (!html.includes(vidId) && !missingVidWarned && elapsed >= 60) {
        missingVidWarned = true;
        log(
          `   [${String(elapsed).padStart(3)}s] uyarı: vid_id sayfada yok — yanlış proje ID veya eski vid_id olabilir (projectID=${ctx.projectId})`,
        );
      }

      const { url, label } = extractUrl(html, vidId);
      if (url) {
        log(`   [${String(elapsed).padStart(3)}s] HAZIR (${label}): ...${url.slice(-60)}`);
        return downloadStream(url, outPath);
      }
      log(
        `   [${String(elapsed).padStart(3)}s] henüz hazır değil${apiStatus ? ` (status=${apiStatus})` : ""}`,
      );
    } catch (e) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      log(`   [${String(elapsed).padStart(3)}s] poll hatası: ${e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(
    "Hailuo poll ZAMAN AŞIMI (60 dk) — token/cookie yenile; Hailuo'da videoyu kontrol et; eski vid_id ise hailuo_router_progress.json silip yeniden başlat",
  );
}

export function normalizePrompt(prompt: string): string {
  return (prompt || "").replace(/^\[([^\]]+)\]/, (_, inner: string) => {
    return `[${inner.replace(/, /g, ",")}]`;
  });
}
