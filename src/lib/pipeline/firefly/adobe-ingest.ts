/**
 * Firefly cURL / Bearer yapıştırmasından kimlik bilgilerini ayıklar.
 * Kaynak: F12 → Network → generate-async | ingest | storage/image → Copy as cURL.
 */

import fs from "fs";
import path from "path";

export type FireflyExtractedCreds = {
  token: string | null;
  arp: string | null;
  nonce: string | null;
  apiKey: string | null;
  userAgent: string | null;
  fromCurl: boolean;
};

/** Windows curl.exe ^"..." kaçışlarını sadeleştir */
function unescapeCurl(text: string): string {
  return text
    .replace(/\^"/g, '"')
    .replace(/\^&/g, "&")
    .replace(/\^\^/g, "^")
    .replace(/\r\n/g, "\n");
}

function headerValue(text: string, name: string): string | null {
  // -H "name: value" | name: value | Windows ^" kaçışı çözülmüş halde
  const re = new RegExp(
    `(?:^|[\\s"'^-])${name}\\s*[:=]\\s*["']?([^"'\\r\\n]+)`,
    "i",
  );
  const m = text.match(re);
  if (!m) return null;
  return m[1].replace(/["'\\^]+$/g, "").trim() || null;
}

export function extractFireflyCredsFromPaste(raw: string): FireflyExtractedCreds {
  const text = unescapeCurl(String(raw || "").trim());
  if (!text) {
    return { token: null, arp: null, nonce: null, apiKey: null, userAgent: null, fromCurl: false };
  }

  const fromCurl = /curl(\.exe)?\b|adobe\.io\/|firefly-3p|authorization\s*:/i.test(text);

  let token: string | null = null;
  const authM = text.match(
    /authorization\s*[:=]\s*(?:Bearer\s+)?(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i,
  );
  if (authM) token = authM[1];
  if (!token) {
    const bearerM = text.match(/Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i);
    if (bearerM) token = bearerM[1];
  }
  if (!token) {
    const jwtM = text.match(/^(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    if (jwtM) token = jwtM[1];
  }

  let arp = headerValue(text, "x-arp-session-id");
  if (!arp && /^[A-Za-z0-9._+-]{20,}$/.test(text) && !text.startsWith("eyJ")) {
    arp = text;
  }

  let nonce = headerValue(text, "x-nonce");
  if (nonce) {
    nonce = nonce.replace(/[^A-Fa-f0-9-]/g, "");
    if (nonce.length < 16) nonce = null;
  }

  const apiKey = headerValue(text, "x-api-key");
  const userAgent = headerValue(text, "user-agent") || headerValue(text, "User-Agent");

  return { token, arp, nonce, apiKey, userAgent, fromCurl };
}

/** Ayıklananları disk dosyalarına yazar; kaydedilen dosya adlarını döner. */
export function persistFireflyCreds(
  extracted: FireflyExtractedCreds,
  codeRoot: string,
): { token: string; saved: string[] } {
  const token = extracted.token;
  if (!token || token.length < 20) {
    throw new Error("Bearer token bulunamadı — generate-async / ingest cURL yapıştır");
  }

  const saved: string[] = [];
  const write = (name: string, data: string) => {
    fs.writeFileSync(path.join(codeRoot, name), data, "utf8");
    saved.push(name);
  };

  write("firefly_token.txt", token);

  if (extracted.arp) {
    // Genel + model-özel (Kling/Runway kendi dosyasını okur)
    write("firefly_arp.txt", extracted.arp);
    write("kling_arp.txt", extracted.arp);
    write("runway_arp.txt", extracted.arp);
  }
  if (extracted.nonce) {
    write("firefly_nonce.txt", extracted.nonce);
    write("kling_nonce.txt", extracted.nonce);
    write("runway_nonce.txt", extracted.nonce);
  }
  if (extracted.userAgent) write("firefly_user_agent.txt", extracted.userAgent);
  if (extracted.apiKey) write("firefly_api_key.txt", extracted.apiKey);

  return { token, saved: [...new Set(saved)] };
}
