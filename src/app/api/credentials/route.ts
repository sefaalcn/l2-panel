import { NextResponse } from "next/server";
import { checkCookie } from "@/lib/cookie-check";
import { credentialFoundFlags, loadCredentialFiles } from "@/lib/credentials";

export const dynamic = "force-dynamic";

/** hailuo / firefly kimlik dosyalarını otomatik okuma */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() || null;
  const creds = loadCredentialFiles(project);
  const found = credentialFoundFlags(creds);
  const cookieCheck = checkCookie(creds.cookie || "");
  const { cookie: _c, ...safe } = creds;
  return NextResponse.json({
    credentials: safe,
    found,
    cookie: cookieCheck,
    project,
  });
}
