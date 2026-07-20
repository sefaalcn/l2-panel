import crypto from "crypto";
import { jobLabel, retry, type Job } from "../router/core";
import {
  GENERATE_3P_ASYNC,
  baseHeaders,
  downloadVideo,
  pollResult,
  readOptional,
} from "./client";

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

/** (label, variant) -> stabil seed — _firefly3p.stable_seed portu */
export function stableSeed(job: Job): number {
  const h = crypto.createHash("md5").update(`${jobLabel(job)}_${job.variant}`).digest("hex");
  return Number(BigInt(`0x${h}`) % BigInt(1_000_000));
}

export function f3pHeaders(arpFile: string | null, nonceFile: string | null): Record<string, string> {
  const h: Record<string, string> = { ...baseHeaders(), "content-type": "application/json" };
  if (arpFile) {
    const v = readOptional(arpFile);
    if (v) h["x-arp-session-id"] = v;
  }
  if (nonceFile) {
    const v = readOptional(nonceFile);
    if (v) h["x-nonce"] = v;
  }
  return h;
}

function extractResultUrl(resp: Response, body: Record<string, unknown>): string {
  const href = resp.headers.get("x-override-status-link");
  if (href) return href.replace(/\/$/, "");
  const links = (body.links || {}) as { result?: { href?: string } };
  return String(
    links.result?.href || body.statusUrl || body.resultUrl || body.href || "",
  );
}

async function pollAndDownload(job: Job, href: string, tag: string, log: (s: string) => void) {
  const [url] = await retry(() => pollResult(href, log), {
    label: "firefly-poll",
    attempts: 5,
    backoffs: [5, 15, 30, 45, 60],
    log,
  });
  const out = await retry(() => downloadVideo(url, job.outPath, log), {
    label: "firefly-download",
    attempts: 5,
    backoffs: [5, 15, 30, 45, 60],
    log,
  });
  log(`\n>> BİTTİ (${tag}). Video: ${out}`);
  return out;
}

/** _firefly3p.submit portu — POST-retry -> result URL -> poll -> indir */
export async function submitF3p(
  job: Job,
  payload: Record<string, unknown>,
  arpFile: string | null,
  nonceFile: string | null,
  tag: string,
  log: (s: string) => void = console.log,
): Promise<string> {
  // RESUME: href kaydedilmiş — POST yok; href ölmüşse yeniden üretime düş
  if (job.resumeVidId) {
    log(`>> [RESUME] ${tag}: result URL ile poll+download (POST YOK)`);
    try {
      return await pollAndDownload(job, job.resumeVidId, tag, log);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("401") || msg.includes("403")) throw e;
      log(`   [RESUME] result URL ölü/geçersiz -> YENİDEN ÜRETİME düşülüyor`);
    }
  }

  const hd = f3pHeaders(arpFile, nonceFile);

  log(`>> [1] generate (${tag} / firefly-3p async)...`);
  let resp: Response | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    resp = await retry(
      () =>
        fetch(GENERATE_3P_ASYNC, {
          method: "POST",
          headers: hd,
          body: JSON.stringify(payload),
        }),
      { label: "generate-post", log },
    );
    log(`   deneme ${attempt}: HTTP ${resp.status}`);
    if (resp.status === 401) throw new Error("401 = token süresi dolmuş.");
    if (TRANSIENT.has(resp.status)) {
      const wait = 8 * attempt;
      log(`   >> geçici sunucu hatası. ${wait}s bekleyip tekrar...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  if (!resp) throw new Error(`${tag} generate-async: yanıt yok`);

  let body: Record<string, unknown> = {};
  const rawText = await resp.text();
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    /* header'dan href çıkarılabilir */
  }

  if (resp.status >= 400) {
    log(`   --- SUNUCU HATA (ham) ---`);
    log(rawText.slice(0, 2000));
    // Firefly moderasyon = HTTP 451; S4 classify bu metni arar
    throw new Error(`${tag} generate-async HTTP ${resp.status}`);
  }

  const href = extractResultUrl(resp, body);
  if (!href) {
    throw new Error(`${tag} result URL bulunamadı (header/gövde).`);
  }
  log(`   result URL: ${href}`);
  if (job.onSubmit) await job.onSubmit(href);

  return pollAndDownload(job, href, tag, log);
}
