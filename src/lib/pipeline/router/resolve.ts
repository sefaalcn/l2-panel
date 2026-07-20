import fs from "fs";
import path from "path";
import type { KeyframesSource } from "@/lib/ingest";
import { KEYFRAMES_SOURCE_FILE } from "@/lib/ingest";

export type ResolvedPaths = {
  videoDir: string;
  promptsJson: string;
  keyframesDir: string;
  outputDir: string;
  progressFile: string;
};

export function resolveRouterPaths(
  provider: string,
  videoDir: string,
  keyframesSource?: KeyframesSource,
): ResolvedPaths {
  const root = path.resolve(videoDir);
  const name = path.basename(root);
  const promptsJson = path.join(root, `${name}_output`, "hailuo_prompts_claude.json");

  let source = keyframesSource;
  if (!source) {
    const pref = path.join(root, KEYFRAMES_SOURCE_FILE);
    if (fs.existsSync(pref)) {
      const v = fs.readFileSync(pref, "utf8").trim().toLowerCase();
      source = v === "swapped" ? "swapped" : "original";
    } else {
      source = "original";
    }
  }

  let keyframesDir = path.join(root, "keyframes");
  if (source === "swapped") {
    const swapped = path.join(root, "keyframes_swapped");
    keyframesDir = fs.existsSync(swapped) ? swapped : keyframesDir;
  }

  if (provider === "firefly") {
    return {
      videoDir: root,
      promptsJson,
      keyframesDir,
      outputDir: path.join(root, "firefly_videos"),
      progressFile: path.join(root, "firefly_progress.json"),
    };
  }

  return {
    videoDir: root,
    promptsJson,
    keyframesDir,
    outputDir: path.join(root, "hailuo_router_videos"),
    progressFile: path.join(root, "hailuo_router_progress.json"),
  };
}

export function parseVariantsFlag(value: string): string[] {
  const out: string[] = [];
  for (const part of (value || "").split(",")) {
    let p = part.trim().toLowerCase();
    if (!p) continue;
    if (!p.startsWith("v")) p = `v${p}`;
    if (!out.includes(p)) out.push(p);
  }
  if (!out.length) throw new Error("variants boş/geçersiz (örn: v1,v3)");
  return out;
}

export function parseScenesArg(arg: string): Set<number> {
  const scenes = new Set<number>();
  for (const part of arg.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("-")) {
      const [s, e] = trimmed.split("-");
      for (let i = Number(s); i <= Number(e); i++) scenes.add(i);
    } else {
      scenes.add(Number(trimmed));
    }
  }
  return scenes;
}
