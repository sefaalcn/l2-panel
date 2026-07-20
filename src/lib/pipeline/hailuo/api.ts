import { HAILUO_BASE } from "./constants";
import type { HailuoContext } from "./context";
import { getCookies, log } from "./context";
import { buildQuery, computeYy, hlHeaders, hlParams } from "./sign";

export type UploadTuple = [string, string, string];

export async function apiCall(
  apiPath: string,
  body: Record<string, unknown>,
  token: string,
  ctx: HailuoContext,
): Promise<Record<string, unknown>> {
  const params = hlParams();
  const yy = computeYy(apiPath, params, body);
  const q = buildQuery(params);
  const bodyStr = JSON.stringify(body);
  const r = await fetch(`${HAILUO_BASE}${apiPath}?${q}`, {
    method: "POST",
    headers: hlHeaders(token, ctx.projectId, yy, getCookies(ctx)),
    body: bodyStr,
  });
  if (!r.ok) {
    log(`    API ${r.status}: ${(await r.text()).slice(0, 500)}`);
  }
  if (!r.ok) throw new Error(`Hailuo API ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
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
      if (typeof v === "string" && v.includes(".mp4")) {
        return v.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
      }
    }
  }
  for (const v of Object.values(o)) {
    const hit = deepFindDownloadUrl(v, vidId);
    if (hit) return hit;
  }
  return null;
}

/** GET /v1/api/multimodal/video/result — HTML/feed yedeklerinden önce dener.
 *  404/5xx = henüz yok veya endpoint yok → throw etme; feed+HTML devam etsin.
 */
export async function pollVideoResultApi(
  vidId: string,
  token: string,
  ctx: HailuoContext,
): Promise<{ url: string | null; status: string }> {
  const q = buildQuery(hlParams());
  const url = `${HAILUO_BASE}/v1/api/multimodal/video/result?${q}&videoID=${encodeURIComponent(vidId)}`;
  const r = await fetch(url, {
    headers: hlHeaders(token, ctx.projectId, "", getCookies(ctx)),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error("Hailuo token süresi dolmuş (result API) — token/cookie yenile");
  }
  // 404 sık: video henüz result endpoint'te yok — poll döngüsünü kırma
  if (!r.ok) return { url: null, status: `http_${r.status}` };
  const resp = (await r.json()) as Record<string, unknown>;
  const data = (resp.data || {}) as Record<string, unknown>;
  const direct = String(data.videoURL || data.video_url || data.downloadURL || "").trim();
  if (direct) return { url: direct, status: String(data.status || "ready") };
  const nested = deepFindDownloadUrl(resp, vidId);
  return { url: nested, status: String(data.status || "") };
}

/** processing feed — HTML scrape yedek */
export async function pollFeedForDownload(
  vidId: string,
  token: string,
  ctx: HailuoContext,
): Promise<string | null> {
  const bodies: Record<string, unknown>[] = [
    { batchInfoList: [], type: 1, projectID: ctx.projectId },
    { batchInfoList: [{ videoID: vidId }], type: 1, projectID: ctx.projectId },
    { videoID: vidId, projectID: ctx.projectId },
  ];
  for (const body of bodies) {
    try {
      const resp = await apiCall("/api/feed/creation/my/processing", body, token, ctx);
      const hit = deepFindDownloadUrl(resp, vidId);
      if (hit) return hit;
    } catch {
      /* sonraki body dene */
    }
  }
  return null;
}

export async function heartbeat(token: string, ctx: HailuoContext): Promise<number> {
  try {
    const path = "/api/feed/creation/my/processing";
    const body = {
      batchInfoList: [],
      type: 1,
      projectID: ctx.projectId,
    };
    const resp = await apiCall(path, body, token, ctx);
    const data = (resp.data || {}) as Record<string, unknown>;
    const processing = Number(data.onProcessingVideoNum || 0);
    log(`    💓 Heartbeat OK — kuyrukta ${processing} video`);
    return processing;
  } catch (e) {
    log(`    💓 Heartbeat hatası: ${e}`);
    return -1;
  }
}

export const MAX_QUEUE = 4;

export async function waitForQueue(token: string, ctx: HailuoContext, label = "") {
  while (true) {
    const count = await heartbeat(token, ctx);
    if (count < 0) {
      await sleep(30_000);
      continue;
    }
    if (count < MAX_QUEUE) {
      if (label) log(`    ✅ Kuyruk müsait (${count}/${MAX_QUEUE}) — ${label} gönderiliyor`);
      return count;
    }
    log(`    ⏳ Kuyruk dolu (${count}/${MAX_QUEUE}) — 30s bekleniyor...`);
    await sleep(30_000);
  }
}

export async function generateVideo(
  first: UploadTuple,
  last: UploadTuple,
  prompt: string,
  token: string,
  ctx: HailuoContext,
  opts: {
    frameMode?: string;
    duration?: number;
    resolution?: string;
    useOriginPrompt?: boolean | null;
  } = {},
): Promise<string> {
  const frameMode = opts.frameMode || "both";
  const duration = opts.duration ?? 6;
  const resolution = opts.resolution ?? "1080";
  const useOrigin =
    opts.useOriginPrompt ?? ctx.useOriginPrompt;

  const [firstId, firstUrl, firstName] = first;
  const [lastId, lastUrl, lastName] = last;

  let fileList: Record<string, unknown>[];
  let referenceMode: string;

  const strip = (u: string) => u.split("?")[0];

  if (frameMode === "both") {
    fileList = [
      {
        frameType: 0,
        id: firstId,
        name: firstName,
        type: "jpeg",
        characterUrl: "",
        url: strip(firstUrl),
      },
      {
        frameType: 1,
        id: lastId,
        name: lastName,
        type: "jpeg",
        characterUrl: "",
        url: strip(lastUrl),
      },
    ];
    referenceMode = "start-end-frames";
  } else if (frameMode === "end_only") {
    fileList = [
      {
        frameType: 1,
        id: lastId,
        name: lastName,
        type: "jpeg",
        characterUrl: "",
        url: strip(lastUrl),
      },
    ];
    referenceMode = "start-end-frames";
  } else {
    fileList = [
      {
        frameType: 0,
        id: firstId,
        name: firstName,
        type: "jpeg",
        characterUrl: "",
        url: strip(firstUrl),
      },
    ];
    referenceMode = "start-frame";
  }

  const promptLen = prompt.length;
  const promptStruct = JSON.stringify({
    value: [{ type: "paragraph", children: [{ text: prompt }] }],
    length: promptLen,
    plainLength: promptLen,
    rawLength: promptLen,
  });

  const body = {
    projectID: ctx.projectId,
    quantity: 1,
    parameter: {
      modelID: ctx.modelId,
      desc: prompt,
      fileList,
      referenceMode,
      useOriginPrompt: useOrigin,
      resolution,
      duration,
      aspectRatio: "",
    },
    videoExtra: { promptStruct },
  };

  const resp = await apiCall("/v2/api/multimodal/generate/video", body, token, ctx);
  log(`    API: ${JSON.stringify(resp).slice(0, 300)}`);

  const statusInfo = (resp.statusInfo || {}) as Record<string, unknown>;
  const statusCode = Number(statusInfo.code || 0);
  if (statusCode !== 0) {
    throw new Error(`API error ${statusCode}: ${statusInfo.message || ""}`);
  }

  const data = (resp.data || {}) as Record<string, unknown>;
  const vidId =
    data.videoID || data.video_id || data.id || resp.videoID || resp.video_id;
  if (!vidId) throw new Error(`video_id alınamadı: ${JSON.stringify(resp)}`);
  return String(vidId);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
