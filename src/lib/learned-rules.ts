import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";

export const LEARNED_RULES_FILE = "hailuo_learned_rules.txt";

export type RuleSeverity = "must" | "soft";

const HEADER = `# Hailuo — Gemini learned rules
# ONLY for Gemini when WRITING prompts. Never paste into Hailuo/Firefly video prompts.
# MUST = hard constraint. SOFT = prefer / watch out.

## MUST
`;

const SOFT_HEADER = `
## SOFT
`;

export function learnedRulesPath(project: string): string {
  return path.join(PROJECTS_ROOT, project, LEARNED_RULES_FILE);
}

export function learnedRulesPathFromBase(baseDir: string): string {
  return path.join(baseDir, LEARNED_RULES_FILE);
}

export function loadLearnedRulesRaw(project: string): string {
  const fp = learnedRulesPath(project);
  if (!fs.existsSync(fp)) return "";
  return fs.readFileSync(fp, "utf8");
}

export function loadLearnedRulesFromBase(baseDir: string): string {
  const fp = learnedRulesPathFromBase(baseDir);
  if (!fs.existsSync(fp)) return "";
  return fs.readFileSync(fp, "utf8");
}

function ensureFile(project: string) {
  const fp = learnedRulesPath(project);
  if (!fs.existsSync(fp)) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, HEADER + SOFT_HEADER, "utf8");
  }
  return fp;
}

function parseSections(raw: string): { must: string[]; soft: string[] } {
  const must: string[] = [];
  const soft: string[] = [];
  let section: "must" | "soft" | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^##\s*MUST/i.test(t)) {
      section = "must";
      continue;
    }
    if (/^##\s*SOFT/i.test(t)) {
      section = "soft";
      continue;
    }
    if (!t || t.startsWith("#") || !section) continue;
    const rule = t.replace(/^[-*•]\s*/, "").trim();
    if (rule) (section === "must" ? must : soft).push(rule);
  }
  return { must, soft };
}

function serialize(must: string[], soft: string[]): string {
  const m = must.map((r) => `- ${r}`).join("\n");
  const s = soft.map((r) => `- ${r}`).join("\n");
  return `${HEADER}${m ? m + "\n" : ""}${SOFT_HEADER}${s ? s + "\n" : ""}`;
}

export function listLearnedRules(project: string): {
  must: string[];
  soft: string[];
  raw: string;
} {
  const raw = loadLearnedRulesRaw(project);
  if (!raw.trim()) return { must: [], soft: [], raw: "" };
  const { must, soft } = parseSections(raw);
  return { must, soft, raw };
}

/** Append one approved rule. Dedupes exact match (case-insensitive). */
export function appendLearnedRule(
  project: string,
  rule: string,
  severity: RuleSeverity,
): { must: string[]; soft: string[]; raw: string } {
  const text = rule.trim().replace(/^[-*•]\s*/, "");
  if (!text) throw new Error("Kural boş");
  ensureFile(project);
  const cur = listLearnedRules(project);
  const target = severity === "must" ? cur.must : cur.soft;
  const other = severity === "must" ? cur.soft : cur.must;
  const low = text.toLowerCase();
  if (target.some((r) => r.toLowerCase() === low) || other.some((r) => r.toLowerCase() === low)) {
    return { ...cur, raw: loadLearnedRulesRaw(project) };
  }
  if (severity === "must") cur.must.push(text);
  else cur.soft.push(text);
  const raw = serialize(cur.must, cur.soft);
  fs.writeFileSync(learnedRulesPath(project), raw, "utf8");
  return { must: cur.must, soft: cur.soft, raw };
}

/**
 * Block for Gemini prompt-writing context ONLY.
 * Instructs model not to copy rules into v1/v2/v3.
 */
export function formatLearnedRulesForGemini(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  const { must, soft } = parseSections(t);
  if (!must.length && !soft.length) return "";
  const lines: string[] = [
    "LEARNED RULES FROM CREATOR FEEDBACK (apply while WRITING prompts).",
    "⚠️ These are instructions for YOU — do NOT paste this block or rule labels into v1/v2/v3 text.",
  ];
  if (must.length) {
    lines.push("MUST (hard — never violate):");
    for (const r of must) lines.push(`- ${r}`);
  }
  if (soft.length) {
    lines.push("SOFT (prefer / watch out):");
    for (const r of soft) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}
