import {
  MAX_V1,
  MAX_V2,
  MAX_V3,
  STYLE_TAG_FACE,
  STYLE_TAG_PLAIN,
} from "./prompts";

export function normalizeChar(text: string): string {
  return text;
}

export function parseJsonArray(text: string | undefined | null): Record<string, unknown>[] | null {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith("```")) t = t.split("\n").slice(1).join("\n");
  if (t.endsWith("```")) t = t.replace(/```\s*$/, "");
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const m = t.match(/\[[\s\S]*\]/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function clip(
  text: string,
  mx: number,
  isV1V3: boolean,
  faceVisible = true,
): string {
  if (!text) return text;
  if (text.toLowerCase().includes("not applicable")) return text;
  let t = text;
  t = t.replace(/\s*3[dD]\s+(children'?s|animated)?\s*cartoon style\.?/gi, "");
  t = t.replace(/,?\s*(soft|warm|bright)?\s*(outdoor|ambient)?\s*lighting[^.,]*/gi, "");
  t = t.replace(/\b(Vibrant colorful 3D cartoon[^.]*smooth shading)/gi, "");
  t = t.replace(/\s*--[a-zA-Z]+\s+[0-9:.]+/g, "");
  t = t.replace(/\s*\[\s*STYLE[^\]]*\]/gi, "");
  t = t.replace(/ ,/g, ",").replace(/  +/g, " ").trim().replace(/,$/, "").trim();
  if (isV1V3) {
    const tag = faceVisible ? STYLE_TAG_FACE : STYLE_TAG_PLAIN;
    t = `${t} ${tag}`;
  }
  return t;
}

export function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

export { MAX_V1, MAX_V2, MAX_V3 };
