/** JWT / Adobe access_token kalan süresi (saniye). */
export function tokenExpRemaining(token: string): number | null {
  try {
    const v = token.replace(/^Bearer\s+/i, "").trim();
    const part = v.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as {
      exp?: number;
      created_at?: string | number;
      expires_in?: string | number;
    };

    // Standart JWT (Hailuo vb.)
    if (typeof payload.exp === "number") {
      return payload.exp - Date.now() / 1000;
    }

    // Adobe Firefly access_token: created_at + expires_in (ms)
    const created = Number(payload.created_at);
    const expiresIn = Number(payload.expires_in);
    if (Number.isFinite(created) && Number.isFinite(expiresIn) && expiresIn > 0) {
      const expMs = created + expiresIn;
      return (expMs - Date.now()) / 1000;
    }

    return null;
  } catch {
    return null;
  }
}
