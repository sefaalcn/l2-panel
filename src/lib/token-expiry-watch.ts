import fs from "fs";
import path from "path";
import { PANEL_DIR } from "./config";
import { loadCredentialFiles } from "./credentials";
import { notifyTokenExpiring } from "./telegram";
import {
  type ExpiryItem,
  expiryWarningMessage,
  scanCredentialExpiries,
} from "./token-expiry";

const NOTICE_FILE = path.join(PANEL_DIR, ".l2_token_expiry_notices.json");

type NoticeMap = Record<string, number>;

function readNotices(): NoticeMap {
  try {
    if (!fs.existsSync(NOTICE_FILE)) return {};
    return JSON.parse(fs.readFileSync(NOTICE_FILE, "utf8")) as NoticeMap;
  } catch {
    return {};
  }
}

function writeNotices(map: NoticeMap) {
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  fs.writeFileSync(NOTICE_FILE, JSON.stringify(map, null, 2), "utf8");
}

function shouldNotify(id: string, expiresAtSec: number, notices: NoticeMap): boolean {
  return notices[id] !== expiresAtSec;
}

function markNotified(id: string, expiresAtSec: number, notices: NoticeMap) {
  notices[id] = expiresAtSec;
}

export function watchCredentialExpiries(
  creds: Record<string, string>,
  opts?: { notify?: boolean; project?: string },
): ExpiryItem[] {
  const expiring = scanCredentialExpiries(creds);
  if (!opts?.notify || !expiring.length) return expiring;

  const notices = readNotices();
  const now = Date.now() / 1000;
  let dirty = false;

  for (const item of expiring) {
    const expiresAtSec = Math.floor(now + item.remainingSec);
    if (!shouldNotify(item.id, expiresAtSec, notices)) continue;
    notifyTokenExpiring({
      project: opts.project || "—",
      label: item.label,
      remainingSec: item.remainingSec,
      message: expiryWarningMessage(item),
    });
    markNotified(item.id, expiresAtSec, notices);
    dirty = true;
  }

  if (dirty) writeNotices(notices);
  return expiring;
}

export function watchProjectCredentialExpiries(project?: string | null, notify = true): ExpiryItem[] {
  const creds = loadCredentialFiles(project);
  return watchCredentialExpiries(creds, { notify, project: project || undefined });
}
