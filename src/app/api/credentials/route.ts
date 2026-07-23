import { NextResponse } from "next/server";
import { checkCookie } from "@/lib/cookie-check";
import { credentialFoundFlags, loadCredentialFiles } from "@/lib/credentials";
import { expiryWarningMessage } from "@/lib/token-expiry";
import { watchCredentialExpiries } from "@/lib/token-expiry-watch";

export const dynamic = "force-dynamic";

/** hailuo / firefly kimlik dosyalarını otomatik okuma */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() || null;
  const creds = loadCredentialFiles(project);
  const found = credentialFoundFlags(creds);
  const cookieCheck = checkCookie(creds.cookie || "");
  const expiringSoon = watchCredentialExpiries(creds, { notify: true, project: project || undefined });
  const { cookie: _c, ...safe } = creds;
  return NextResponse.json({
    credentials: safe,
    found,
    cookie: cookieCheck,
    expiring_soon: expiringSoon.map((item) => ({
      ...item,
      message: expiryWarningMessage(item),
    })),
    project,
  });
}
