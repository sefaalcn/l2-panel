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

export function resolveApiKey(name: ApiKeyName, env: NodeJS.ProcessEnv = process.env): string {
  let v = String(env[name] || sessionKeys[name] || "").trim();
  if (v) return v;

  const staged = env[`${name}_FILE`];
  if (staged) v = readTrim(String(staged));
  if (v) return v;

  v = readTrim(apiKeyFilePath(name));
  if (v) return v;

  return String(process.env[name] || "").trim();
}

export function apiKeyIsSet(name: ApiKeyName): boolean {
  return Boolean(sessionKeys[name]?.trim() || loadApiKeyFiles()[name] || process.env[name]?.trim());
}

/** Panel POST body > session > dosya > process.env */
export function mergeApiKeysIntoEnv(
  env: NodeJS.ProcessEnv,
  bodyKeys?: Record<string, string | null | undefined>,
) {
  const files = loadApiKeyFiles();
  for (const name of API_KEY_NAMES) {
    let v = String(sessionKeys[name] || files[name] || process.env[name] || "").trim();

    if (bodyKeys && name in bodyKeys) {
      const bodyVal = String(bodyKeys[name] ?? "").trim();
      if (bodyVal) v = bodyVal;
    }

    if (v) {
      sessionKeys[name] = v;
      env[name] = v;
    }
  }
}

/** Worker spawn öncesi — Windows'ta env kaybına karşı dosyaya yaz. */
export function stageApiKeysForWorker(env: NodeJS.ProcessEnv) {
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  for (const name of API_KEY_NAMES) {
    const v = resolveApiKey(name, env);
    if (!v) continue;
    const fpath = path.join(PANEL_DIR, STAGE_FILES[name]);
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

export function cleanStagedApiKeyFiles() {
  for (const fname of Object.values(STAGE_FILES)) {
    try {
      fs.unlinkSync(path.join(PANEL_DIR, fname));
    } catch {
      /* */
    }
  }
}
