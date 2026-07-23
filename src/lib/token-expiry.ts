import { tokenExpRemaining } from "./token";

/** Süre dolmadan kaç saniye önce uyarı verilsin */
export const EXPIRY_WARN_SEC = 30 * 60;

export type ExpiryItem = {
  id: string;
  label: string;
  remainingSec: number;
};

export function formatRemainingShort(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.ceil(sec))} sn`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min} dk`;
  return `${(sec / 3600).toFixed(1)} sa`;
}

function pushIfSoon(items: ExpiryItem[], id: string, label: string, remainingSec: number | null) {
  if (remainingSec == null || remainingSec <= 0 || remainingSec > EXPIRY_WARN_SEC) return;
  items.push({ id, label, remainingSec });
}

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

export function scanCredentialExpiries(creds: Record<string, string>): ExpiryItem[] {
  const items: ExpiryItem[] = [];

  if (creds.token) {
    pushIfSoon(items, "hailuo_token", "Hailuo Token", tokenExpRemaining(creds.token));
  }
  if (creds.ff_token) {
    pushIfSoon(items, "firefly_token", "Firefly Token", tokenExpRemaining(creds.ff_token));
  }

  const cookie = (creds.cookie || "").trim();
  if (cookie) {
    const tokenVal = parseCookiePair(cookie, "_token");
    if (tokenVal) {
      pushIfSoon(items, "hailuo_cookie_token", "Hailuo Cookie (_token)", tokenExpRemaining(tokenVal));
    }
    pushIfSoon(items, "hailuo_cookie_cf", "Hailuo Cookie (cf_clearance)", cfClearanceRemainingSec(cookie));
    pushIfSoon(items, "hailuo_cookie_session", "Hailuo Cookie (oturum)", gcSessionRemainingSec(cookie));
  }

  return items.sort((a, b) => a.remainingSec - b.remainingSec);
}

export function expiryWarningMessage(item: ExpiryItem): string {
  return `${item.label} — ${formatRemainingShort(item.remainingSec)} kaldı, yenile`;
}
