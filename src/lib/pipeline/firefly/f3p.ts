import crypto from "crypto";
import { jobLabel, retry, type Job } from "../router/core";
import {
  GENERATE_3P_ASYNC,
  buildFireflyHeaders,
  downloadVideo,
  pollResult,
  readOptional,
} from "./client";
import { fireflyFetch, isCurlImpersonateActive } from "./http";

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

/** (label, variant) -> stabil seed — _firefly3p.stable_seed portu */
export function stableSeed(job: Job): number {
  const h = crypto.createHash("md5").update(`${jobLabel(job)}_${job.variant}`).digest("hex");
  return Number(BigInt(`0x${h}`) % BigInt(1_000_000));
}

/** Model-özel arp (kling_arp.txt vb.); nonce her denemede taze 64-hex */
export function f3pHeaders(arpFile: string | null): Record<string, string> {
  // ARP önceliği: model-özel (kling/runway) → genel firefly_arp
  let arpValue: string | null = null;
  if (arpFile) arpValue = readOptional(arpFile);
  if (!arpValue) arpValue = readOptional("firefly_arp.txt");
  // buildFireflyHeaders içinde Firefox insertion order korunacak şekilde inject
  return buildFireflyHeaders({
    contentType: "application/json",
    arpValue,
  });
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

function peekErrorMessage(raw: string): string {
  try {
    const j = JSON.parse(raw) as { message?: string; error_code?: string };
    const parts = [j.error_code, j.message].filter(Boolean);
    return parts.join(": ") || raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

/** _firefly3p.submit portu — POST-retry -> result URL -> poll -> indir */
export async function submitF3p(
  job: Job,
  payload: Record<string, unknown>,
  arpFile: string | null,
  _nonceFile: string | null,
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

  log(`>> [1] generate (${tag} / firefly-3p async)...`);
  if (isCurlImpersonateActive()) {
    log(`   HTTP: curl-impersonate (Firefox135 TLS/H2 fingerprint)`);
  } else {
    log(`   HTTP: native fetch — 408 riski yüksek; FIREFLY_CURL_IMPERSONATE kur`);
  }
  let resp: Response | null = null;
  let lastRaw = "";
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptHeaders = f3pHeaders(arpFile);
    resp = await retry(
      () =>
        fireflyFetch(GENERATE_3P_ASYNC, {
          method: "POST",
          headers: attemptHeaders,
          body: JSON.stringify(payload),
        }),
      { label: "generate-post", log },
    );
    log(`   deneme ${attempt}/${maxAttempts}: HTTP ${resp.status}`);
    if (resp.status === 401) {
      throw new Error("Firefly Bearer token süresi dolmuş (video üretimi) — panelden Firefly Token yenile");
    }
    if (resp.status === 403) {
      throw new Error("Firefly yetki hatası (403) — panelden Firefly Token + arp yenile (F12)");
    }
    if (TRANSIENT.has(resp.status)) {
      lastRaw = await resp.text().catch(() => "");
      const peek = peekErrorMessage(lastRaw);
      if (peek) log(`   Adobe: ${peek}`);
      if (attempt >= maxAttempts) {
        // body zaten okundu — sahte Response yerine status'u korumak için yeniden sarmala
        resp = new Response(lastRaw, { status: resp.status, headers: resp.headers });
        break;
      }
      // system under load → uzun bekle, kısa aralıkla spam etme
      const underLoad = /under load|timeout_error/i.test(peek);
      const wait = underLoad ? 45 + 30 * attempt : resp.status === 408 ? 15 * attempt : 8 * attempt;
      log(`   >> geçici sunucu hatası (${resp.status}). ${wait}s bekleyip tekrar...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  if (!resp) throw new Error(`${tag} generate-async: yanıt yok`);

  let body: Record<string, unknown> = {};
  const rawText = lastRaw && resp.status >= 400 ? lastRaw : await resp.text();
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    /* header'dan href çıkarılabilir */
  }

  if (resp.status >= 400) {
    log(`   --- SUNUCU HATA (ham) ---`);
    log(rawText.slice(0, 2000));
    const peek = peekErrorMessage(rawText);
    if (resp.status === 408 || /under load|timeout_error/i.test(peek)) {
      throw new Error(
        `${tag} Adobe yoğun/timeout (${peek || "408"}) — Firefly sitesinde üretimi dene; rahatlayınca Hatalıları tekrar dene`,
      );
    }
    throw new Error(`${tag} generate-async HTTP ${resp.status}${peek ? ` — ${peek}` : ""}`);
  }

  const href = extractResultUrl(resp, body);
  if (!href) {
    throw new Error(`${tag} result URL bulunamadı (header/gövde).`);
  }
  log(`   result URL: ${href}`);
  if (job.onSubmit) await job.onSubmit(href);

  return pollAndDownload(job, href, tag, log);
}
