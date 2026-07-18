import { NextResponse } from "next/server";
import { listProjects } from "@/lib/projects";
import { PROJECTS_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    root: PROJECTS_ROOT,
    runtime: "local",
    projects: listProjects(),
  });
}
