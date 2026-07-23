import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";

/** Kullanıcının işaretlediği kötü çıktı nedenleri — Gemini'ye ders olarak gider. */
export const FAIL_TAGS = [
  { key: "morph", label: "Morph / şekil bozulması" },
  { key: "end_miss", label: "End pose kaçtı (landing yok)" },
  { key: "frozen", label: "Karakter donuk" },
  { key: "identity", label: "Kimlik / görünüm bozuldu" },
  { key: "physics_flat", label: "Fizik yok (ağırlık/tepki)" },
  { key: "camera_fight", label: "Kamera uyumsuz" },
  { key: "too_much_action", label: "Fazla aksiyon (zincir)" },
  {
    key: "story_break",
    label: "Olay/bağlam kopukluğu",
  },
] as const;

export type FailTagKey = (typeof FAIL_TAGS)[number]["key"];

export type FailLessonItem = {
  file: string;
  scene: string | null;
  variant: string | null;
  tags: FailTagKey[];
  note?: string;
  at: number;
};

export type FailLessonsFile = {
  updated_at: number;
  items: FailLessonItem[];
};

const FILE_NAME = "hailuo_fail_lessons.json";

export function failLessonsPath(project: string): string {
  return path.join(PROJECTS_ROOT, project, FILE_NAME);
}

export function loadFailLessons(project: string): FailLessonsFile {
  const fp = failLessonsPath(project);
  if (!fs.existsSync(fp)) return { updated_at: 0, items: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as FailLessonsFile;
    return {
      updated_at: Number(raw.updated_at) || 0,
      items: Array.isArray(raw.items) ? raw.items : [],
    };
  } catch {
    return { updated_at: 0, items: [] };
  }
}

export function loadFailLessonsFromBase(baseDir: string): FailLessonsFile {
  const fp = path.join(baseDir, FILE_NAME);
  if (!fs.existsSync(fp)) return { updated_at: 0, items: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as FailLessonsFile;
    return {
      updated_at: Number(raw.updated_at) || 0,
      items: Array.isArray(raw.items) ? raw.items : [],
    };
  } catch {
    return { updated_at: 0, items: [] };
  }
}

function isFailTag(t: string): t is FailTagKey {
  return FAIL_TAGS.some((x) => x.key === t);
}

export function upsertFailLessons(
  project: string,
  incoming: Omit<FailLessonItem, "at">[],
): FailLessonsFile {
  const cur = loadFailLessons(project);
  const byFile = new Map(cur.items.map((i) => [i.file, i]));
  const now = Date.now() / 1000;
  for (const raw of incoming) {
    const file = String(raw.file || "").trim();
    if (!file) continue;
    const tags = (raw.tags || []).filter(isFailTag);
    if (!tags.length) {
      byFile.delete(file);
      continue;
    }
    byFile.set(file, {
      file,
      scene: raw.scene ?? null,
      variant: raw.variant ?? null,
      tags,
      note: (raw.note || "").trim() || undefined,
      at: now,
    });
  }
  const next: FailLessonsFile = {
    updated_at: now,
    items: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)),
  };
  fs.writeFileSync(failLessonsPath(project), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function removeFailLessons(project: string, files: string[]): FailLessonsFile {
  const cur = loadFailLessons(project);
  const drop = new Set(files.map((f) => f.trim()).filter(Boolean));
  const next: FailLessonsFile = {
    updated_at: Date.now() / 1000,
    items: cur.items.filter((i) => !drop.has(i.file)),
  };
  fs.writeFileSync(failLessonsPath(project), JSON.stringify(next, null, 2), "utf8");
  return next;
}

const TAG_LESSON: Record<FailTagKey, string> = {
  morph:
    "Avoid literal squash/stretch/transform; keep ONE gentle continuous motion; no head swelling or eyes leaving sockets.",
  end_miss:
    "ALWAYS end v1/v2 with an explicit LANDING clause that matches the END frame pose (e.g. 'ending seated holding the ball'). For frame_mode=both, study the END image.",
  frozen:
    "Give EVERY visible character at least one small verb (glance/lean/step/blink) joined with while/as.",
  identity:
    "Keep appearance from CHARACTERS / start frame only; drop wrong hair/face/clothing adjectives.",
  physics_flat:
    "Add one short cause→effect physics beat (contact puff, hair lag, soft bounce) that still lands in the end pose.",
  camera_fight:
    "Use ONLY the official camera BRACKET that matches the real video motion; no conflicting prose camera.",
  too_much_action:
    "Use ONE Anticipation→Action→Follow-through flow joined with as/while/ending — not a then→then list. Emotion must shift with the beat (no grin during a snatch/cry ending).",
  story_break:
    "Stay locked to the user note's STORY ORDER and causal context. Name characters obviously. Emotion must track the beat (fear when snatch starts → cry as follow-through). Never keep a start-frame smile/laugh through a loss/hurt ending; never invent an unrelated action that breaks the scene's event chain.",
};

/** Gemini user-message bloğu — başarısız çıktılardan ders. */
export function formatFailLessonsForGemini(data: FailLessonsFile): string {
  if (!data.items.length) return "";
  const lines: string[] = [
    "LESSONS FROM FAILED HAILUO OUTPUTS (creator marked these — do NOT repeat the same mistakes):",
  ];
  for (const it of data.items.slice(0, 40)) {
    const where = [it.scene, it.variant].filter(Boolean).join(" / ") || it.file;
    const tags = it.tags.join(", ");
    const note = it.note ? ` — note: ${it.note}` : "";
    lines.push(`- ${where} [${tags}]${note}`);
  }
  const seen = new Set<FailTagKey>();
  lines.push("DISTILLED FIX RULES (apply on EVERY scene you write now):");
  for (const it of data.items) {
    for (const t of it.tags) {
      if (seen.has(t)) continue;
      seen.add(t);
      lines.push(`- [${t}] ${TAG_LESSON[t]}`);
    }
  }
  return lines.join("\n");
}
