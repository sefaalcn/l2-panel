import { NextResponse } from "next/server";
import {
  cleanCredFiles,
  clearRunstate,
  getActiveRun,
  listActiveRuns,
  pidAlive,
} from "@/lib/runstate";

export const dynamic = "force-dynamic";

/** Body: { project?: string } — verilirse yalnız o proje; yoksa tüm aktif koşular */
export async function POST(req: Request) {
  let project: string | undefined;
  try {
    const body = (await req.json()) as { project?: string };
    project = body?.project ? String(body.project).trim() : undefined;
  } catch {
    project = undefined;
  }

  const targets = project
    ? [getActiveRun(project)].filter(Boolean)
    : listActiveRuns();

  const stopped: { project?: string; pid?: number }[] = [];
  for (const rs of targets) {
    if (!rs) continue;
    const pid = rs.pid;
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid);
        } catch {
          /* */
        }
      }
      stopped.push({ project: rs.project, pid });
    }
    if (rs.project) {
      cleanCredFiles(rs.project);
      clearRunstate(rs.project);
    }
  }

  if (!targets.length && project) {
    cleanCredFiles(project);
    clearRunstate(project);
  }

  return NextResponse.json({
    stopped: stopped.length > 0,
    stopped_runs: stopped,
    pid: stopped[0]?.pid,
    project: project || stopped[0]?.project,
    message:
      stopped.length > 0
        ? `${stopped.length} koşu durduruldu`
        : project
          ? "Bu proje için aktif koşu yok — temizlendi"
          : "aktif koşu yok — temizlendi",
    runtime: "local",
  });
}
