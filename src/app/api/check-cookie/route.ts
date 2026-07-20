import { NextResponse } from "next/server";
import { checkCookie } from "@/lib/cookie-check";
import { loadCredentialFiles } from "@/lib/credentials";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() || null;
  const creds = loadCredentialFiles(project);
  return NextResponse.json(checkCookie(creds.cookie || ""));
}

export async function POST(req: Request) {
  const { value } = (await req.json()) as { value?: string };
  return NextResponse.json(checkCookie(value || ""));
}
