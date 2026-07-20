import fs from "fs";
import path from "path";
import type { KeyframesSource } from "@/lib/ingest";

export type SceneRow = Record<string, unknown> & {
  index: number;
  label?: string;
  frame_mode?: string;
  scene_description?: string;
};

export type ProjectPaths = {
  base: string;
  name: string;
  videoPath: string;
  scenesJson: string;
  outputDir: string;
  promptsJson: string;
  overlayJson: string;
  storyFile: string;
  charsFile: string;
  themeFile: string;
  swapFlagFile: string;
  charRefsDir: string;
  geminiCacheFile: string;
  keyframesSwappedDir: string;
  keyframesOrigDir: string;
  keyframesSource: KeyframesSource;
};

export function setupProject(projectPath: string, keyframesSource: KeyframesSource): ProjectPaths {
  const base = path.resolve(projectPath);
  if (!fs.existsSync(base)) throw new Error(`Klasör yok: ${base}`);
  const name = path.basename(base);

  const videos = fs
    .readdirSync(base)
    .filter((n) => n.toLowerCase().endsWith(".mp4"))
    .sort();
  if (!videos.length) throw new Error(`${base} içinde .mp4 yok`);
  const videoPath = path.join(base, videos[0]);

  const scenesCandidates = fs
    .readdirSync(base)
    .filter(
      (n) =>
        n.endsWith(".json") &&
        !n.toLowerCase().includes("progress") &&
        !n.includes("_gemini") &&
        (n.includes("_scenes_manual") || n.includes("scenes")),
    );
  const manual = scenesCandidates.find((n) => n.includes("_scenes_manual"));
  const scenesJson = path.join(base, manual || scenesCandidates[0] || "");
  if (!fs.existsSync(scenesJson)) throw new Error(`${base} içinde *scenes*.json yok`);

  let kfSwapped = path.join(base, "keyframes_swapped");
  let kfOrig = path.join(base, "keyframes");
  if (keyframesSource === "swapped") {
    if (!fs.existsSync(kfSwapped)) kfSwapped = kfOrig;
    kfOrig = kfSwapped;
  } else {
    kfSwapped = kfOrig;
  }

  const outputDir = path.join(base, `${name}_output`);
  return {
    base,
    name,
    videoPath,
    scenesJson,
    outputDir,
    promptsJson: path.join(outputDir, "hailuo_prompts_claude.json"),
    overlayJson: path.join(base, `${name}_overlay_cues.json`),
    storyFile: path.join(base, `${name}_story.txt`),
    charsFile: path.join(base, `${name}_characters.txt`),
    themeFile: path.join(base, `${name}_theme.txt`),
    swapFlagFile: path.join(base, `${name}_swap.txt`),
    charRefsDir: path.join(base, "char_refs"),
    geminiCacheFile: path.join(base, `${name}_gemini_file_cache.json`),
    keyframesSwappedDir: kfSwapped,
    keyframesOrigDir: kfOrig,
    keyframesSource,
  };
}

export function loadScenes(scenesJson: string): SceneRow[] {
  const raw = JSON.parse(fs.readFileSync(scenesJson, "utf8"));
  return (Array.isArray(raw) ? raw : raw.scenes || []) as SceneRow[];
}

export function readTextFileIfExists(f: string): string {
  if (!fs.existsSync(f)) return "";
  return fs.readFileSync(f, "utf8").trim();
}

export function buildVideoContext(paths: ProjectPaths): string {
  const story = readTextFileIfExists(paths.storyFile);
  const chars = readTextFileIfExists(paths.charsFile);
  const theme = readTextFileIfExists(paths.themeFile);
  const parts: string[] = [];
  if (story) parts.push(`STORY (event flow):\n${story}`);
  if (chars) parts.push(`CHARACTERS (role + appearance):\n${chars}`);
  if (theme) parts.push(`THEME / TONE:\n${theme}`);
  return parts.join("\n\n");
}

export function parseScenesFilter(arg: string | null | undefined): { lo: number; hi: number } {
  if (!arg?.trim()) return { lo: 1, hi: 999999 };
  const a = arg.trim();
  if (a.includes("-")) {
    const [s, e] = a.split("-");
    return { lo: parseInt(s, 10), hi: parseInt(e, 10) };
  }
  const n = parseInt(a, 10);
  return { lo: n, hi: n };
}

export function log(msg: string) {
  console.log(msg);
}
