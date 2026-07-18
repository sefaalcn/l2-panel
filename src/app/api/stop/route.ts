import { NextResponse } from "next/server";
import { cleanCredFiles, clearRunstate, pidAlive, readRunstate } from "@/lib/runstate";

export const dynamic = "force-dynamic";

export async function POST() {
  const rs = readRunstate();
  const pid = rs?.pid;
  let stopped = false;
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {
      try {
        process.kill(pid);
        stopped = true;
      } catch {
        /* */
      }
    }
  }
  cleanCredFiles();
  clearRunstate();
  return NextResponse.json({
    stopped,
    pid,
    message: stopped ? "durduruldu" : "aktif koşu yok — temizlendi",
    runtime: "local",
  });
}
