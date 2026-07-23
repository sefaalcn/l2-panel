import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { CODE_ROOT } from "@/lib/config";
import { fireflyFetch } from "./http";

/** Adobe Firefly nonce format: 64 hex (sha256). UUID formatı Adobe fingerprint filtresinde takılıyor. */
export function freshNonce(): string {
  return randomBytes(32).toString("hex");
}

export const UPLOAD_URL = "https://firefly-3p.ff.adobe.io/v2/storage/image";
export const GENERATE_3P_ASYNC = "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async";
export const API_KEY = "clio-playground-web";
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";

function loadApiKey(): string {
  return readOptional("firefly_api_key.txt") || API_KEY;
}

function loadUserAgent(): string {
  return readOptional("firefly_user_agent.txt") || DEFAULT_UA;
}

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
  if (!token) throw new Error("Firefly token yok — panelde Firefly Curl yapıştır veya firefly_token.txt");
  return token.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Firefly 3p — tarayıcı Firefox 153 isteğiyle birebir header seti.
 *
 * Header sırası ÖNEMLİ (bot fingerprint): object insertion order korunur.
 * Firefox 153'ün gerçek generate-async isteğiyle aynı sıra:
 *   User-Agent → Accept → Accept-Language → Accept-Encoding →
 *   Referer → Content-Type → Authorization → x-api-key → x-nonce →
 *   x-arp-session-id → Origin → Connection → Sec-Fetch-* → Priority → TE
 *
 * `arpFile` undefined → varsayılan `firefly_arp.txt` denenir.
 * `arpFile` null      → hiç ARP eklenmez.
 * `arpValue`          → doğrudan verilen değer (dosya okuma bypass).
 */
export function buildFireflyHeaders(opts?: {
  contentType?: string;
  arpFile?: string | null;
  arpValue?: string | null;
}): Record<string, string> {
  const h: Record<string, string> = {};
  // Curl'den kayıtlı UA varsa onu kullan; yoksa Firefox135 (curl-impersonate ile uyumlu)
  h["User-Agent"] = loadUserAgent();
  h["Accept"] = "*/*";
  h["Accept-Language"] = "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7";
  h["Accept-Encoding"] = "gzip, deflate, br, zstd";
  h["Referer"] = "https://firefly.adobe.com/";
  if (opts?.contentType) h["content-type"] = opts.contentType;
  h["authorization"] = `Bearer ${loadToken()}`;
  h["x-api-key"] = loadApiKey();
  h["x-nonce"] = freshNonce();

  let arp: string | null = null;
  if (opts?.arpValue !== undefined) {
    arp = opts.arpValue;
  } else {
    const arpName = opts?.arpFile === undefined ? "firefly_arp.txt" : opts.arpFile;
    if (arpName) arp = readOptional(arpName);
  }
  if (arp) h["x-arp-session-id"] = arp;

  h["Origin"] = "https://firefly.adobe.com";
  h["Connection"] = "keep-alive";
  h["Sec-Fetch-Dest"] = "empty";
  h["Sec-Fetch-Mode"] = "cors";
  h["Sec-Fetch-Site"] = "cross-site";
  h["Priority"] = "u=4";
  h["TE"] = "trailers";
  return h;
}

export function baseHeaders(): Record<string, string> {
  return buildFireflyHeaders();
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
  const headers = buildFireflyHeaders({ contentType: ctype });

  log(`>> [0] yükleniyor: ${path.basename(imagePath)}  (${Math.round(data.length / 1024)} KB, ${ctype})`);
  const resp = await fireflyFetch(UPLOAD_URL, {
    method: "POST",
    headers,
    body: new Uint8Array(data),
  });
  log(`   HTTP ${resp.status}`);
  if (resp.status === 401) {
    throw new Error("Firefly Bearer token süresi dolmuş (görsel yükleme) — panelden Firefly Token yenile");
  }
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
    const resp = await fireflyFetch(resultUrl, { headers: baseHeaders() });
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (resp.status === 401) {
      throw new Error("Firefly Bearer token süresi dolmuş (sonuç bekleme) — panelden Firefly Token yenile");
    }
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
  // Presigned S3 URL — Firefly header'ları GEREKMEZ, kullanmıyoruz.
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
