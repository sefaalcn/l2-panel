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

/** ZIP bazen keyframes/proje_keyframes/.../keyframes/scene_XXX diye iç içe gelir. */
export function hasSceneDirs(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && /^scene_/i.test(e.name));
  } catch {
    return false;
  }
}

function dirNonEmpty(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function resolveKeyframesLeaf(dir: string, depth = 0): string {
  if (!fs.existsSync(dir) || depth > 6) return dir;
  if (hasSceneDirs(dir)) return dir;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return dir;
  }
  const nestedNamed = ents.find(
    (e) => e.isDirectory() && /keyframes/i.test(e.name),
  );
  if (nestedNamed) {
    const cand = resolveKeyframesLeaf(path.join(dir, nestedNamed.name), depth + 1);
    if (hasSceneDirs(cand)) return cand;
  }
  const onlyDirs = ents.filter((e) => e.isDirectory());
  if (onlyDirs.length === 1) {
    const cand = resolveKeyframesLeaf(path.join(dir, onlyDirs[0].name), depth + 1);
    if (hasSceneDirs(cand)) return cand;
  }
  return dir;
}

/**
 * Seçilen kaynağın gerçek keyframes kökü.
 * Swapped seçiliyse keyframes_swapped yok/boş → HATA (orijinale sessiz düşmez).
 */
export function resolveActiveKeyframesDir(
  root: string,
  source: KeyframesSource = "original",
): string {
  const label = source === "swapped" ? "keyframes_swapped" : "keyframes";
  const preferred = path.join(path.resolve(root), label);
  if (!fs.existsSync(preferred)) {
    if (source === "swapped") {
      throw new Error(
        "keyframes_swapped/ yok — Swapped seçildi. ZIP'i «Swapped» olarak yükle veya koşuda «Orijinal» seç.",
      );
    }
    throw new Error("keyframes/ yok — Orijinal keyframes ZIP yükle.");
  }
  const leaf = resolveKeyframesLeaf(preferred);
  if (!hasSceneDirs(leaf) && !dirNonEmpty(leaf)) {
    if (source === "swapped") {
      throw new Error(
        "keyframes_swapped/ boş — Swapped ZIP yükle veya koşuda «Orijinal» seç.",
      );
    }
    throw new Error("keyframes/ boş — Orijinal keyframes ZIP yükle.");
  }
  return leaf;
}

/** Orijinal / swapped klasörlerini ayrı tut (Gemini identity mapping için). */
export function resolveKeyframeRoots(root: string): {
  orig: string;
  swapped: string | null;
} {
  const base = path.resolve(root);
  const origRaw = path.join(base, "keyframes");
  const swapRaw = path.join(base, "keyframes_swapped");
  const orig = fs.existsSync(origRaw) ? resolveKeyframesLeaf(origRaw) : origRaw;
  if (!fs.existsSync(swapRaw)) return { orig, swapped: null };
  const swapped = resolveKeyframesLeaf(swapRaw);
  // Aynı leaf'e çöktüyse (yanlış yapı) tek klasör say
  if (path.resolve(swapped) === path.resolve(orig)) return { orig, swapped: null };
  return { orig, swapped };
}

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

  const keyframesDir = resolveActiveKeyframesDir(root, source);

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
