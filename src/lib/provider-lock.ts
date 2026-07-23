import fs from "fs";
import path from "path";
import { PANEL_DIR } from "./config";
import { pidAlive } from "./runstate";

export type ProviderLockName = "gemini" | "hailuo" | "firefly";

type LockPayload = {
  pid: number;
  project: string;
  acquired_at: number;
};

const LOCK_DIR = path.join(PANEL_DIR, "locks");
const localHold = new Map<ProviderLockName, number>();

function lockPath(provider: ProviderLockName): string {
  return path.join(LOCK_DIR, `${provider}.lock`);
}

function readLock(provider: ProviderLockName): LockPayload | null {
  try {
    const p = lockPath(provider);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as LockPayload;
  } catch {
    return null;
  }
}

function writeLock(provider: ProviderLockName, data: LockPayload) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const p = lockPath(provider);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function releaseLock(provider: ProviderLockName, pid: number) {
  const cur = readLock(provider);
  if (cur && cur.pid === pid) {
    try {
      fs.unlinkSync(lockPath(provider));
    } catch {
      /* */
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Aynı provider'a (gemini/hailuo/firefly) çapraz-proje erişimi sıraya koyar.
 * Aynı process içinde reentrant (Hailuo concurrency=2 için).
 */
export async function withProviderLock<T>(
  provider: ProviderLockName,
  project: string,
  log: (s: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const held = localHold.get(provider) || 0;
  if (held === 0) {
    // Başka process tutuyorsa bekle
    for (;;) {
      const cur = readLock(provider);
      if (!cur || !pidAlive(cur.pid) || cur.pid === process.pid) {
        writeLock(provider, {
          pid: process.pid,
          project,
          acquired_at: Date.now() / 1000,
        });
        // Kazanan biz miyiz? (yarış)
        await sleep(50);
        const check = readLock(provider);
        if (check && check.pid === process.pid) break;
        continue;
      }
      log(
        `⏳ ${provider} kuyruk: ${cur.project} (pid ${cur.pid}) bitene kadar bekleniyor...`,
      );
      await sleep(4000);
    }
    log(`🔒 ${provider} kilit alındı (${project})`);
  }
  localHold.set(provider, held + 1);
  try {
    return await fn();
  } finally {
    const n = (localHold.get(provider) || 1) - 1;
    if (n <= 0) {
      localHold.delete(provider);
      releaseLock(provider, process.pid);
      log(`🔓 ${provider} kilit bırakıldı (${project})`);
    } else {
      localHold.set(provider, n);
    }
  }
}
