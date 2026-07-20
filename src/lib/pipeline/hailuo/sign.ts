import crypto from "crypto";
import { HAILUO_DEVICE_ID, HAILUO_UUID } from "./constants";

/** Python hl_params() anahtar sırası — yy imzası için kritik */
export const HL_PARAM_KEYS = [
  "device_platform",
  "app_id",
  "version_code",
  "biz_id",
  "unix",
  "lang",
  "uuid",
  "device_id",
  "os_name",
  "browser_name",
  "cpu_core_num",
  "browser_language",
  "browser_platform",
  "screen_width",
  "screen_height",
] as const;

/** Python urllib.parse.quote(s, safe="-_.!~*'()") */
function quoteUrl(s: string): string {
  const safe = new Set("-_.!~*'()".split(""));
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const isUnreserved =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      safe.has(ch);
    out += isUnreserved ? ch : `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function hlParams(unixMs?: number): Record<string, string> {
  const unix = unixMs ?? Date.now();
  return {
    device_platform: "web",
    app_id: "3001",
    version_code: "22203",
    biz_id: "0",
    unix: String(unix),
    lang: "en",
    uuid: HAILUO_UUID,
    device_id: HAILUO_DEVICE_ID,
    os_name: "Mac",
    browser_name: "firefox",
    cpu_core_num: "14",
    browser_language: "tr-TR",
    browser_platform: "MacIntel",
    screen_width: "2560",
    screen_height: "1440",
  };
}

/** Python urlencode(list(params.items())) — sıra korunur */
export function buildQuery(params: Record<string, string>): string {
  return HL_PARAM_KEYS.filter((k) => k in params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
}

/** hailuo_pipeline._compute_yy */
export function computeYy(
  urlPath: string,
  params: Record<string, string>,
  body: Record<string, unknown>,
  method = "POST",
): string {
  const query = buildQuery(params);
  const fullUrl = `${urlPath}?${query}`;
  const bodyStr =
    method.toLowerCase() === "post" || method.toLowerCase() === "delete"
      ? JSON.stringify(body)
      : "{}";
  const timestamp = params.unix ?? String(Date.now());
  const timeMd5 = crypto.createHash("md5").update(timestamp).digest("hex");
  const encUrl = quoteUrl(fullUrl);
  const raw = `${encUrl}_${bodyStr}${timeMd5}ooui`;
  return crypto.createHash("md5").update(raw).digest("hex");
}

export function hlHeaders(
  token: string,
  projectId: string,
  yy = "",
  cookie = "",
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Content-Type": "application/json",
    token,
    Origin: "https://hailuoai.video",
    Referer: `https://hailuoai.video/create/image-to-video?projectId=${projectId}`,
  };
  if (yy) headers.yy = yy;
  if (cookie) headers.Cookie = cookie;
  return headers;
}
