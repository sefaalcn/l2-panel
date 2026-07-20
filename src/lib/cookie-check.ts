import { tokenExpRemaining } from "./token";

export type CookieCheck = {
  /** Dosya var mı */
  ok: boolean;
  /** null = süre okunamadı */
  valid: boolean | null;
  message: string;
  cf_expires_in_h?: number | null;
  token_expires_in_h?: number | null;
};

function parseCookiePair(cookie: string, name: string): string | null {
  const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`);
  const m = cookie.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

function cfClearanceRemainingSec(cookie: string): number | null {
  const v = parseCookiePair(cookie, "cf_clearance");
  if (!v) return null;
  const m = v.match(/-(\d{10})-1\.2\.1\.1-/);
  if (!m) return null;
  return parseInt(m[1], 10) - Date.now() / 1000;
}

function gcSessionRemainingSec(cookie: string): number | null {
  for (const [k, v] of cookie.split(";").map((p) => p.trim().split("="))) {
    if (!k.startsWith("_gc_s_") || !v) continue;
    const em = decodeURIComponent(v).match(/expire=(\d+)/);
    if (em) return parseInt(em[1], 10) / 1000 - Date.now() / 1000;
  }
  return null;
}

export function checkCookie(cookie: string): CookieCheck {
  const trimmed = cookie.trim();
  if (!trimmed) {
    return { ok: false, valid: false, message: "yok" };
  }

  const issues: string[] = [];
  const hints: string[] = [];
  let expired = false;

  const cfRem = cfClearanceRemainingSec(trimmed);
  if (cfRem != null) {
    if (cfRem <= 0) {
      expired = true;
      issues.push("cf_clearance dolmuş");
    } else {
      hints.push(`cf ${(cfRem / 3600).toFixed(1)}h`);
    }
  }

  const tokenVal = parseCookiePair(trimmed, "_token");
  let tokenRem: number | null = null;
  if (tokenVal) {
    tokenRem = tokenExpRemaining(tokenVal);
    if (tokenRem !== null && tokenRem <= 0) {
      expired = true;
      issues.push("_token dolmuş");
    } else if (tokenRem !== null && tokenRem > 0) {
      hints.push(`token ${(tokenRem / 3600).toFixed(1)}h`);
    }
  }

  const gcRem = gcSessionRemainingSec(trimmed);
  if (gcRem != null && gcRem <= 0) {
    expired = true;
    issues.push("oturum dolmuş");
  }

  if (expired) {
    return {
      ok: true,
      valid: false,
      message: issues.join(" · "),
      cf_expires_in_h: cfRem != null ? Math.round((cfRem / 3600) * 10) / 10 : null,
      token_expires_in_h: tokenRem != null ? Math.round((tokenRem / 3600) * 10) / 10 : null,
    };
  }

  if (hints.length) {
    return {
      ok: true,
      valid: true,
      message: hints.join(" · "),
      cf_expires_in_h: cfRem != null ? Math.round((cfRem / 3600) * 10) / 10 : null,
      token_expires_in_h: tokenRem != null ? Math.round((tokenRem / 3600) * 10) / 10 : null,
    };
  }

  return { ok: true, valid: null, message: "geçerli" };
}
