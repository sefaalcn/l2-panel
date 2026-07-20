import fs from "fs";
import os from "os";
import path from "path";
import { HAILUO_BASE, HAILUO_MODEL_20 } from "./constants";

export type HailuoContext = {
  baseDir: string;
  projectName: string;
  projectId: string;
  modelId: string;
  useOriginPrompt: boolean;
};

export function log(msg: string) {
  console.log(msg);
}

export function setupContext(videoDir: string, modelId = HAILUO_MODEL_20): HailuoContext {
  const baseDir = path.resolve(videoDir);
  if (!fs.existsSync(baseDir)) throw new Error(`Klasör yok: ${baseDir}`);
  const projectName = path.basename(baseDir);
  const projectId = resolveProjectId(baseDir);
  return {
    baseDir,
    projectName,
    projectId,
    modelId,
    useOriginPrompt: false,
  };
}

function resolveProjectId(baseDir: string): string {
  const pf = path.join(baseDir, "hailuo_project.txt");
  const envPf = (process.env.HAILUO_PROJECT_FILE || "").trim();
  if (envPf && fs.existsSync(envPf)) {
    return fs.readFileSync(envPf, "utf8").trim();
  }
  if (fs.existsSync(pf)) {
    return fs.readFileSync(pf, "utf8").trim();
  }
  throw new Error(
    `Hailuo proje ID yok. ${pf} oluştur veya panelden Proje ID gir.`,
  );
}

export function credCandidates(envVar: string, defaultName: string, baseDir: string): string[] {
  const cands: string[] = [];
  const ep = (process.env[envVar] || "").trim();
  if (ep) cands.push(ep);
  cands.push(path.join(baseDir, defaultName));
  cands.push(path.join(os.homedir(), "Desktop", defaultName));
  return cands;
}

export function getHailuoToken(ctx: HailuoContext): string {
  for (const tf of credCandidates("HAILUO_TOKEN_FILE", "hailuo_token.txt", ctx.baseDir)) {
    if (fs.existsSync(tf)) {
      const t = fs.readFileSync(tf, "utf8").trim();
      if (!t) continue;
      return t;
    }
  }
  throw new Error(
    `hailuo_token.txt bulunamadı. Panelden token gir veya ${ctx.baseDir} altına koy.`,
  );
}

export function getCookies(ctx: HailuoContext): string {
  for (const cf of credCandidates("HAILUO_COOKIE_FILE", "hailuo_cookie.txt", ctx.baseDir)) {
    if (fs.existsSync(cf)) {
      return fs.readFileSync(cf, "utf8").trim();
    }
  }
  return "";
}
