import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { CODE_ROOT } from "@/lib/config";

export const UPLOAD_URL = "https://firefly-3p.ff.adobe.io/v2/storage/image";
export const GENERATE_3P_ASYNC = "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async";
export const API_KEY = "clio-playground-web";

const POLL_INTERVAL = 5_000;
const POLL_TIMEOUT = 600_000;

function pathFromEnv(envKey: string, defaultName: string): string {
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.join(CODE_ROOT, defaultName);
}

/** firefly_gen._read / core.read_optional — env dosyası veya kod kökü */
export function readOptional(name: string): string | null {
  const p = path.isAbsolute(name) ? name : path.join(CODE_ROOT, name);
  try {
    const txt = fs.readFileSync(p, "utf8").trim();
    return txt || null;
  } catch {
    return null;
  }
}

export function loadToken(): string {
  const p = pathFromEnv("FIREFLY_TOKEN_FILE", "firefly_token.txt");
  let token: string | null = null;
  try {
    token = fs.readFileSync(p, "utf8").trim();
  } catch {
    token = readOptional("firefly_token.txt");
  }
  if (!token) throw new Error("Firefly token yok — panelde ff_token girin veya firefly_token.txt");
  return token.replace(/^Bearer\s+/i, "").trim();
}

export function baseHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    authorization: `Bearer ${loadToken()}`,
    origin: "https://firefly.adobe.com",
    referer: "https://firefly.adobe.com/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-api-key": API_KEY,
  };
  const arpPath = pathFromEnv("FIREFLY_ARP_FILE", "firefly_arp.txt");
  try {
    const arp = fs.readFileSync(arpPath, "utf8").trim();
    if (arp) h["x-arp-session-id"] = arp;
  } catch {
    const arp = readOptional("firefly_arp.txt");
    if (arp) h["x-arp-session-id"] = arp;
  }
  const noncePath = pathFromEnv("FIREFLY_NONCE_FILE", "firefly_nonce.txt");
  try {
    const nonce = fs.readFileSync(noncePath, "utf8").trim();
    if (nonce) h["x-nonce"] = nonce;
  } catch {
    const nonce = readOptional("firefly_nonce.txt");
    if (nonce) h["x-nonce"] = nonce;
  }
  return h;
}

class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function guessContentType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export async function uploadImage(imagePath: string, log = console.log): Promise<string> {
  if (!fs.existsSync(imagePath)) throw new Error(`görsel bulunamadı: ${imagePath}`);

  const ctype = guessContentType(imagePath);
  const data = fs.readFileSync(imagePath);
  const headers = { ...baseHeaders(), "content-type": ctype };

  log(`>> [0] yükleniyor: ${path.basename(imagePath)}  (${Math.round(data.length / 1024)} KB, ${ctype})`);
  const resp = await fetch(UPLOAD_URL, {
    method: "POST",
    headers,
    body: new Uint8Array(data),
  });
  log(`   HTTP ${resp.status}`);
  if (resp.status === 401) throw new Error("401 = token süresi dolmuş (upload).");
  if (!resp.ok) throw new HttpError(`upload HTTP ${resp.status}`, resp.status);

  const out = (await resp.json()) as Record<string, unknown>;
  const images = out.images as Array<Record<string, unknown>> | undefined;
  const blobId = out.id || out.imageId || (images?.length ? images[0].id : null);
  if (!blobId) throw new Error(`upload yanıtında id yok: ${JSON.stringify(out).slice(0, 500)}`);
  log(`   blob id: ${blobId}`);
  return String(blobId);
}

function extractVideoUrl(data: Record<string, unknown>): [string | null, string | null] {
  const outputs = data.outputs as Array<Record<string, unknown>> | undefined;
  if (outputs?.length) {
    const video = (outputs[0].video || {}) as Record<string, unknown>;
    let url = video.presignedUrl || video.url;
    if (url) return [String(url), String(video.id || "video")];
    url = outputs[0].presignedUrl || outputs[0].url;
    if (url) return [String(url), String(outputs[0].id || "video")];
  }
  for (const key of ["presignedUrl", "url", "videoUrl", "outputUrl"]) {
    if (data[key]) return [String(data[key]), String(data.id || "video")];
  }
  return [null, null];
}

const RUNNING = new Set(["IN_PROGRESS", "RUNNING", "PENDING", "QUEUED", "PROCESSING"]);
const FAILED = new Set(["FAILED", "ERROR", "CANCELED", "CANCELLED"]);
const DONE = new Set(["", "SUCCEEDED", "SUCCESS", "COMPLETED", "DONE"]);

export async function pollResult(
  resultUrl: string,
  log = console.log,
): Promise<[string, string]> {
  log(">> [2] sonuç bekleniyor (poll)...");
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT) {
    const resp = await fetch(resultUrl, { headers: baseHeaders() });
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (resp.status === 401) throw new Error("401 = token süresi dolmuş (poll).");
    if (!resp.ok) throw new HttpError(`poll HTTP ${resp.status}`, resp.status);

    let data: Record<string, unknown>;
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      log(`   [${String(elapsed).padStart(3)}s] JSON değil`);
      await sleep(POLL_INTERVAL);
      continue;
    }

    const status = String(data.status || "").toUpperCase();
    if (RUNNING.has(status)) {
      const prog = data.progress !== undefined && data.progress !== "" ? ` %${data.progress}` : "";
      log(`   [${String(elapsed).padStart(3)}s] ${status}${prog}`);
      await sleep(POLL_INTERVAL);
      continue;
    }
    if (FAILED.has(status)) {
      throw new Error(`Üretim başarısız: ${status} — ${JSON.stringify(data).slice(0, 500)}`);
    }

    const [url, vid] = extractVideoUrl(data);
    if (url) {
      log(`   [${String(elapsed).padStart(3)}s] TAMAMLANDI  (id: ${vid})`);
      return [url, vid || "video"];
    }
    if (DONE.has(status)) {
      throw new Error(
        `tamamlandı görünüyor ama video URL çıkarılamadı: ${JSON.stringify(data).slice(0, 1000)}`,
      );
    }
    log(`   [${String(elapsed).padStart(3)}s] status=${status}, bekleniyor...`);
    await sleep(POLL_INTERVAL);
  }
  throw new Error("Firefly poll ZAMAN AŞIMI.");
}

export async function downloadVideo(
  presignedUrl: string,
  outPath: string,
  log = console.log,
): Promise<string> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  log(`>> [3] indiriliyor -> ${path.basename(outPath)}`);
  const r = await fetch(presignedUrl);
  if (!r.ok || !r.body) throw new HttpError(`download HTTP ${r.status}`, r.status);
  const nodeStream = Readable.fromWeb(r.body as import("stream/web").ReadableStream);
  await pipeline(nodeStream, fs.createWriteStream(outPath));
  const size = fs.statSync(outPath).size;
  log(`   Kaydedildi: ${outPath}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return outPath;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
