/** Hailuo JWT expiry (paste-time). */
export function tokenExpRemaining(token: string): number | null {
  try {
    const v = token.replace(/^Bearer\s+/i, "").trim();
    const part = v.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const { exp } = JSON.parse(json) as { exp?: number };
    if (typeof exp !== "number") return null;
    return exp - Date.now() / 1000;
  } catch {
    return null;
  }
}
