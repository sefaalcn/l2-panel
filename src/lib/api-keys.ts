import fs from "fs";
import path from "path";
import { CODE_ROOT, PANEL_DIR, sessionKeys } from "./config";

export const API_KEY_NAMES = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

const KEY_FILES: Record<ApiKeyName, string> = {
  GEMINI_API_KEY: "gemini_api_key.txt",
  ANTHROPIC_API_KEY: "anthropic_api_key.txt",
};

const STAGE_FILES: Record<ApiKeyName, string> = {
  GEMINI_API_KEY: ".l2_gemini_api_key.txt",
  ANTHROPIC_API_KEY: ".l2_anthropic_api_key.txt",
};

function readTrim(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function apiKeyFilePath(name: ApiKeyName): string {
  return path.join(CODE_ROOT, KEY_FILES[name]);
}

export function loadApiKeyFiles(): Partial<Record<ApiKeyName, string>> {
  const out: Partial<Record<ApiKeyName, string>> = {};
  for (const name of API_KEY_NAMES) {
    const v = readTrim(apiKeyFilePath(name));
    if (v) out[name] = v;
  }
  return out;
}

export function saveApiKeyFile(name: ApiKeyName, value: string) {
  const v = value.trim();
  const fpath = apiKeyFilePath(name);
  if (v) fs.writeFileSync(fpath, v, "utf8");
  else {
    try {
      fs.unlinkSync(fpath);
    } catch {
      /* */
    }
  }
}

export function isPlausibleApiKey(name: ApiKeyName, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (name === "GEMINI_API_KEY") {
    return v.length >= 20 && !/^studio\d+$/i.test(v);
  }
  return v.length >= 10;
}

export function resolveApiKey(name: ApiKeyName, env: NodeJS.ProcessEnv = process.env): string {
  // Kalıcı dosya önce — geçersiz/kısa dosya değerini yok say
  let v = readTrim(apiKeyFilePath(name));
  if (v && isPlausibleApiKey(name, v)) return v;

  const staged = env[`${name}_FILE`];
  if (staged) {
    v = readTrim(String(staged));
    if (v && isPlausibleApiKey(name, v)) return v;
  }

  v = String(env[name] || process.env[name] || "").trim();
  if (v && isPlausibleApiKey(name, v)) return v;

  v = String(sessionKeys[name] || "").trim();
  if (v && isPlausibleApiKey(name, v)) return v;

  return "";
}

export function apiKeyIsSet(name: ApiKeyName): boolean {
  return Boolean(resolveApiKey(name));
}

/** Dosya > env > session; panel yalnızca dolu yeni değer gönderirse dosyayı günceller */
export function mergeApiKeysIntoEnv(
  env: NodeJS.ProcessEnv,
  bodyKeys?: Record<string, string | null | undefined>,
) {
  for (const name of API_KEY_NAMES) {
    let v = resolveApiKey(name);

    if (bodyKeys && name in bodyKeys) {
      const bodyVal = String(bodyKeys[name] ?? "").trim();
      if (bodyVal && isPlausibleApiKey(name, bodyVal)) {
        v = bodyVal;
        saveApiKeyFile(name, bodyVal);
      }
    }

    if (v) {
      sessionKeys[name] = v;
      env[name] = v;
    }
  }
}

/** Worker spawn öncesi — Windows'ta env kaybına karşı dosyaya yaz. */
export function stageApiKeysForWorker(env: NodeJS.ProcessEnv, project?: string) {
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  const tag = project
    ? project.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)
    : `pid${process.pid}`;
  for (const name of API_KEY_NAMES) {
    const v = resolveApiKey(name, env);
    if (!v) continue;
    const fname =
      name === "GEMINI_API_KEY"
        ? `.l2_${tag}_gemini_api_key.txt`
        : `.l2_${tag}_anthropic_api_key.txt`;
    const fpath = path.join(PANEL_DIR, fname);
    fs.writeFileSync(fpath, v, "utf8");
    env[name] = v;
    env[`${name}_FILE`] = fpath;
  }
}

export function enrichEnvFromKeyFiles(env: NodeJS.ProcessEnv) {
  for (const name of API_KEY_NAMES) {
    const v = resolveApiKey(name, env);
    if (v) env[name] = v;
  }
}

/** Yalnız bu env'deki staged dosyaları sil — paralel koşuları bozmaz */
export function cleanStagedApiKeyFiles(env?: NodeJS.ProcessEnv) {
  const targets = env
    ? API_KEY_NAMES.map((n) => env[`${n}_FILE`]).filter(Boolean)
    : Object.values(STAGE_FILES).map((f) => path.join(PANEL_DIR, f));
  for (const f of targets) {
    try {
      if (f) fs.unlinkSync(String(f));
    } catch {
      /* */
    }
  }
}
