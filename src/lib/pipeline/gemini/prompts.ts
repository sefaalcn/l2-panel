import fs from "fs";
import path from "path";
import { CODE_ROOT } from "@/lib/config";

export const GEMINI_MODEL = "gemini-3.1-pro-preview";
export const MAX_V1 = 460;
export const MAX_V2 = 260;
export const MAX_V3 = 520;
export const STYLE_TAG_FACE =
  "3D children's cartoon, big expressive exaggerated faces";
export const STYLE_TAG_PLAIN = "3D children's cartoon";

/** Promptlar prompts/ klasöründe (Faz 6'da gemini_direct.py'den çıkarıldı). */
function loadPromptFile(name: string): string {
  const p = path.join(CODE_ROOT, "prompts", name);
  const txt = fs.readFileSync(p, "utf8");
  if (!txt.trim()) throw new Error(`Prompt dosyası boş: ${p}`);
  return txt;
}

let systemPrompt: string | null = null;
let selfCheckPrompt: string | null = null;

export function getSystemPrompt(): string {
  if (systemPrompt) return systemPrompt;
  systemPrompt = loadPromptFile("gemini_system_prompt.txt");
  return systemPrompt;
}

export function getSelfCheckInstruction(): string {
  if (selfCheckPrompt) return selfCheckPrompt;
  selfCheckPrompt = loadPromptFile("gemini_self_check.txt");
  return selfCheckPrompt;
}
