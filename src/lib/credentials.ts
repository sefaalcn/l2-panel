import fs from "fs";
import path from "path";
import { CODE_ROOT, PROJECTS_ROOT } from "./config";

function readTrim(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const t = fs.readFileSync(filePath, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

function loadFromDirs(dirs: string[], fname: string): string | null {
  for (const dir of dirs) {
    const v = readTrim(path.join(dir, fname));
    if (v) return v;
  }
  return null;
}

/** Proje kökü veya seçili proje klasöründeki kimlik dosyalarını oku. */
export function loadCredentialFiles(projectName?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const dirs = projectName
    ? [path.join(PROJECTS_ROOT, projectName), CODE_ROOT]
    : [CODE_ROOT];

  const hailuoMap: Record<string, string> = {
    token: "hailuo_token.txt",
    cookie: "hailuo_cookie.txt",
    project: "hailuo_project.txt",
  };
  for (const [key, fname] of Object.entries(hailuoMap)) {
    const v = loadFromDirs(dirs, fname);
    if (v) out[key] = v;
  }

  const fireflyMap: Record<string, string> = {
    ff_token: "firefly_token.txt",
    ff_arp: "firefly_arp.txt",
    ff_nonce: "firefly_nonce.txt",
  };
  for (const [key, fname] of Object.entries(fireflyMap)) {
    const v = loadFromDirs(dirs, fname);
    if (v) out[key] = v;
  }

  return out;
}

export function credentialFoundFlags(creds: Record<string, string>) {
  return {
    token: Boolean(creds.token),
    cookie: Boolean(creds.cookie),
    project: Boolean(creds.project),
    ff_token: Boolean(creds.ff_token),
    ff_arp: Boolean(creds.ff_arp),
    ff_nonce: Boolean(creds.ff_nonce),
  };
}

/** Panel/start — seçili model için credential body birleştir */
export function mergeModelCredentials(
  provider: string,
  fileCreds: Record<string, string>,
  bodyCreds: Record<string, string>,
  modelCreds: readonly { key: string; autoFromFile?: boolean }[],
): Record<string, string> {
  const out: Record<string, string> = { ...fileCreds, ...bodyCreds };
  for (const cred of modelCreds) {
    if (cred.autoFromFile && fileCreds[cred.key]) {
      out[cred.key] = fileCreds[cred.key];
    }
  }
  return out;
}
