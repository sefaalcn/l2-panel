import fs from "fs";
import path from "path";
import { RUNSTATE_PATH, PANEL_DIR } from "./config";

export type RunState = {
  pid?: number;
  project?: string;
  provider?: string;
  status?: string;
  started_at?: number;
  updated_at?: number;
  error?: string;
  rc?: number;
};

export function readRunstate(): RunState | null {
  try {
    if (!fs.existsSync(RUNSTATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(RUNSTATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeRunstate(d: RunState) {
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  const prev = readRunstate() || {};
  const merged: RunState = {
    ...prev,
    ...d,
    updated_at: Date.now() / 1000,
  };
  const tmp = `${RUNSTATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  fs.renameSync(tmp, RUNSTATE_PATH);
}

export function clearRunstate() {
  try {
    fs.unlinkSync(RUNSTATE_PATH);
  } catch {
    /* */
  }
}

export function pidAlive(pid?: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function activeRun(): RunState | null {
  const rs = readRunstate();
  if (rs && pidAlive(rs.pid)) return rs;
  if (rs) clearRunstate();
  return null;
}

export function cleanCredFiles() {
  for (const name of [
    ".l2_token.txt",
    ".l2_cookie.txt",
    ".l2_project.txt",
    ".l2_ff_token.txt",
    ".l2_ff_arp.txt",
    ".l2_ff_nonce.txt",
    ".l2_gemini_api_key.txt",
    ".l2_anthropic_api_key.txt",
  ]) {
    try {
      fs.unlinkSync(path.join(PANEL_DIR, name));
    } catch {
      /* */
    }
  }
}
