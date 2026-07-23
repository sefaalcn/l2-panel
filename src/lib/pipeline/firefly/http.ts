/**
 * Firefly-3p HTTP istemcisi.
 *
 * ÖNEMLİ: npm `undici` paketini import ETME — Gemini files.upload'ı kırar
 * (UND_ERR_INVALID_ARG: invalid content-length header).
 *
 * FIREFLY_CURL_IMPERSONATE set ise (veya tools/curl-impersonate otomatik bulunursa)
 * istekler curl-impersonate ile Firefox TLS + HTTP/2 fingerprint'iyle gider.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { CODE_ROOT } from "@/lib/config";

export type FireflyRequestBody = string | Uint8Array | Buffer | null | undefined;

export interface FireflyRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: FireflyRequestBody;
}

/** lexiforest curl_firefox135.bat — sadece TLS/H2 fingerprint (header'lar bizden) */
const FIREFOX135_FINGERPRINT_ARGS: string[] = [
  "--ciphers",
  "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:TLS_RSA_WITH_AES_128_GCM_SHA256:TLS_RSA_WITH_AES_256_GCM_SHA384:TLS_RSA_WITH_AES_128_CBC_SHA:TLS_RSA_WITH_AES_256_CBC_SHA",
  "--curves",
  "X25519MLKEM768:X25519:P-256:P-384:P-521:ffdhe2048:ffdhe3072",
  "--signature-hashes",
  "ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512:ecdsa_sha1:rsa_pkcs1_sha1",
  "--split-cookies",
  "--http2",
  "--http2-settings",
  "1:65536;2:0;4:131072;5:16384",
  "--http2-pseudo-headers-order",
  "mpas",
  "--http2-window-update",
  "12517377",
  "--http2-stream-weight",
  "42",
  "--http2-stream-exclusive",
  "0",
  "--compressed",
  "--ech",
  "true",
  "--tls-extension-order",
  "0-23-65281-10-11-35-16-5-34-18-51-43-13-45-28-27-65037",
  "--tls-delegated-credentials",
  "ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:ecdsa_sha1",
  "--tls-record-size-limit",
  "4001",
  "--tls-key-shares-limit",
  "3",
  "--cert-compression",
  "zlib,brotli,zstd",
  "--tls-signed-cert-timestamps",
];

let loggedOnce = false;
let resolvedBin: string | null | undefined;

function toolsRoot(): string {
  return path.join(CODE_ROOT, "tools", "curl-impersonate");
}

/** Env veya tools/ altındaki curl-impersonate.exe */
export function resolveCurlImpersonate(): string | null {
  if (resolvedBin !== undefined) return resolvedBin;
  const fromEnv = process.env.FIREFLY_CURL_IMPERSONATE?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) {
    resolvedBin = fromEnv;
    return resolvedBin;
  }
  const candidates = [
    path.join(toolsRoot(), "bin", "curl-impersonate.exe"),
    path.join(toolsRoot(), "bin", "curl-impersonate"),
    path.join(toolsRoot(), "curl-impersonate.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      resolvedBin = c;
      return resolvedBin;
    }
  }
  resolvedBin = null;
  return null;
}

function resolveCacert(): string | null {
  const fromEnv = process.env.CURL_CA_BUNDLE?.trim() || process.env.SSL_CERT_FILE?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(toolsRoot(), "cacert.pem");
  if (fs.existsSync(local)) return local;
  return null;
}

export function isCurlImpersonateActive(): boolean {
  return Boolean(resolveCurlImpersonate());
}

/**
 * Firefly'a giden tüm istekler için tek nokta.
 * curl-impersonate varsa Firefox fingerprint; yoksa native fetch.
 */
export async function fireflyFetch(
  url: string,
  init: FireflyRequestInit = {},
): Promise<Response> {
  const bin = resolveCurlImpersonate();
  if (bin) {
    if (!loggedOnce) {
      loggedOnce = true;
      console.log(`>> Firefly HTTP: curl-impersonate (Firefox135 TLS/H2) → ${bin}`);
    }
    return curlImpersonateFetch(bin, url, init);
  }
  if (!loggedOnce) {
    loggedOnce = true;
    console.log(">> Firefly HTTP: native fetch (curl-impersonate yok)");
  }
  return fetch(url, {
    method: init.method || "GET",
    headers: init.headers,
    body: init.body == null ? undefined : (init.body as BodyInit),
  });
}

async function curlImpersonateFetch(
  bin: string,
  url: string,
  init: FireflyRequestInit,
): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const args: string[] = ["-sS", "-i", ...FIREFOX135_FINGERPRINT_ARGS];

  const cacert = resolveCacert();
  if (cacert) {
    args.push("--cacert", cacert);
  } else {
    // BoringSSL build Windows'ta sistem CA bulamayabilir
    args.push("-k");
  }

  if (method !== "GET") args.push("-X", method);

  const headers = init.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    // Accept-Encoding curl --compressed ile yönetilir; çift set bozar
    if (/^accept-encoding$/i.test(k)) continue;
    args.push("-H", `${k}: ${v}`);
  }

  const hasBody = init.body != null && method !== "GET" && method !== "HEAD";
  let bodyFile: string | null = null;
  if (hasBody) {
    bodyFile = path.join(
      os.tmpdir(),
      `ff-body-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
    );
    const buf = Buffer.isBuffer(init.body)
      ? init.body
      : typeof init.body === "string"
        ? Buffer.from(init.body, "utf8")
        : Buffer.from(init.body as Uint8Array);
    fs.writeFileSync(bodyFile, buf);
    args.push("--data-binary", `@${bodyFile}`);
  }
  args.push(url);

  const binDir = path.dirname(bin);
  return new Promise<Response>((resolve, reject) => {
    const cp = spawn(bin, args, {
      windowsHide: true,
      cwd: binDir,
      env: {
        ...process.env,
        // Windows DLL yolu
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    cp.stdout.on("data", (d) => outChunks.push(d));
    cp.stderr.on("data", (d) => errChunks.push(d));
    cp.on("error", (e) => {
      if (bodyFile) fs.rmSync(bodyFile, { force: true });
      reject(e);
    });
    cp.on("close", (code) => {
      if (bodyFile) fs.rmSync(bodyFile, { force: true });
      if (code !== 0 && outChunks.length === 0) {
        reject(
          new Error(
            `curl-impersonate exit ${code}: ${Buffer.concat(errChunks).toString("utf8").slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        resolve(parseCurlResponse(Buffer.concat(outChunks)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseCurlResponse(raw: Buffer): Response {
  const sepBytes = Buffer.from("\r\n\r\n");
  let searchStart = 0;
  let lastSepIdx = -1;
  while (true) {
    const idx = raw.indexOf(sepBytes, searchStart);
    if (idx < 0) break;
    const bloc = raw.subarray(searchStart, idx).toString("utf8");
    if (/^HTTP\//i.test(bloc.trimStart())) {
      lastSepIdx = idx;
    }
    searchStart = idx + sepBytes.length;
    const nextPeek = raw
      .subarray(idx + sepBytes.length, idx + sepBytes.length + 5)
      .toString("utf8");
    if (!/^HTTP\//i.test(nextPeek)) break;
  }
  if (lastSepIdx < 0) {
    return new Response(new Uint8Array(raw), { status: 200 });
  }
  const headBuf = raw.subarray(0, lastSepIdx).toString("utf8");
  const bodyBuf = new Uint8Array(raw.subarray(lastSepIdx + sepBytes.length));
  const lines = headBuf.split(/\r?\n/);
  const statusLine = lines.shift() || "HTTP/1.1 0";
  const status = Number(statusLine.split(/\s+/)[1]) || 0;
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (/^content-encoding$/i.test(name)) continue;
    if (/^content-length$/i.test(name)) continue;
    if (/^transfer-encoding$/i.test(name)) continue;
    try {
      headers.append(name, value);
    } catch {
      /* invalid header */
    }
  }
  return new Response(bodyBuf, { status, headers });
}
