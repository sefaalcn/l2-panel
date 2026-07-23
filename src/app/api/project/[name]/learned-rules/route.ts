import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { PROJECTS_ROOT } from "@/lib/config";
import { resolveApiKey } from "@/lib/api-keys";
import { GEMINI_MODEL } from "@/lib/pipeline/gemini/prompts";
import { FAIL_TAGS, upsertFailLessons, type FailTagKey } from "@/lib/fail-lessons";
import {
  appendLearnedRule,
  formatLearnedRulesForGemini,
  listLearnedRules,
  loadLearnedRulesRaw,
  type RuleSeverity,
} from "@/lib/learned-rules";

export const dynamic = "force-dynamic";

function projPath(name: string) {
  return path.join(PROJECTS_ROOT, name);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: raw } = await ctx.params;
  const project = decodeURIComponent(raw);
  if (!fs.existsSync(projPath(project))) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }
  const listed = listLearnedRules(project);
  return NextResponse.json({
    project,
    ...listed,
    for_gemini_preview: formatLearnedRulesForGemini(listed.raw),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await ctx.params;
  const project = decodeURIComponent(rawName);
  if (!fs.existsSync(projPath(project))) {
    return NextResponse.json({ detail: `Proje yok: ${project}` }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    tags?: string[];
    note?: string;
    refine?: string;
    previous_understanding?: string;
    previous_rule?: string;
    files?: { file: string; scene?: string | null; variant?: string | null }[];
    understanding?: string;
    proposed_rule?: string;
    severity?: RuleSeverity;
  };

  const action = body.action || "analyze";

  if (action === "approve") {
    const rule = String(body.proposed_rule || "").trim();
    const severity: RuleSeverity = body.severity === "soft" ? "soft" : "must";
    if (!rule) {
      return NextResponse.json({ detail: "proposed_rule gerekli" }, { status: 400 });
    }
    try {
      const listed = appendLearnedRule(project, rule, severity);
      // Fail history de kaydet (işaretli videolar)
      if (Array.isArray(body.files) && body.files.length && Array.isArray(body.tags) && body.tags.length) {
        upsertFailLessons(
          project,
          body.files.map((f) => ({
            file: f.file,
            scene: f.scene ?? null,
            variant: f.variant ?? null,
            tags: (body.tags || []) as FailTagKey[],
            note: body.note,
          })),
        );
      }
      return NextResponse.json({
        project,
        severity,
        rule,
        ...listed,
        message:
          severity === "must"
            ? "Kesin kural eklendi — sonraki Gemini prompt yazımında zorunlu"
            : "Dikkat kuralı eklendi — sonraki Gemini prompt yazımında soft uyarı",
      });
    } catch (e) {
      return NextResponse.json(
        { detail: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  if (action !== "analyze" && action !== "refine") {
    return NextResponse.json({ detail: `Bilinmeyen action: ${action}` }, { status: 400 });
  }

  const apiKey = resolveApiKey("GEMINI_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { detail: "GEMINI_API_KEY gerekli — analizi Gemini yapacak" },
      { status: 400 },
    );
  }

  const tags = (body.tags || []).map(String);
  const tagLabels = tags
    .map((k) => FAIL_TAGS.find((t) => t.key === k)?.label || k)
    .join(", ");
  const note = String(body.note || "").trim();
  const refine = String(body.refine || "").trim();
  const files = Array.isArray(body.files) ? body.files : [];
  const fileBits = files
    .map((f) => [f.scene, f.variant, f.file].filter(Boolean).join(" / "))
    .filter(Boolean)
    .join("; ");

  const existing = loadLearnedRulesRaw(project);

  const system = `You help a children's cartoon Hailuo I2V pipeline learn from creator negative feedback.
You analyze WHY an output was bad and propose ONE reusable writing rule for Gemini (the prompt writer).
Rules are instructions for writing prompts — they must NEVER be pasted into the video prompt text itself.
Reply in Turkish. Return ONLY JSON:
{"understanding":"2-4 short sentences: what you understood went wrong","proposed_rule":"ONE clear reusable rule in English (or Turkish), imperative, no scene ids, max ~40 words"}`;

  let user =
    `Creator marked bad output(s).\n` +
    `Tags: ${tagLabels || "(none)"}\n` +
    `Scenes/files: ${fileBits || "(unspecified)"}\n` +
    `Creator note: ${note || "(no note)"}\n`;

  if (action === "refine") {
    user +=
      `\nPrevious understanding:\n${body.previous_understanding || ""}\n` +
      `Previous proposed rule:\n${body.previous_rule || ""}\n` +
      `Creator clarification (use this to correct your understanding):\n${refine || note}\n`;
  }

  if (existing.trim()) {
    user += `\nExisting learned rules (do not duplicate; refine if needed):\n${existing.slice(0, 2500)}\n`;
  }

  user +=
    `\nFocus on causal story / emotion timing / character clarity / landing when relevant.\n` +
    `proposed_rule must be general (reusable on future scenes), not "fix scene_001".`;

  try {
    const client = new GoogleGenAI({ apiKey });
    const resp = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        temperature: 0.3,
        maxOutputTokens: 1200,
      },
    });
    const text = String(resp.text || "");
    const parsed = parseJsonObject(text);
    if (!parsed) {
      return NextResponse.json(
        { detail: "Gemini JSON döndüremedi", raw: text.slice(0, 500) },
        { status: 502 },
      );
    }
    const understanding = String(parsed.understanding || "").trim();
    const proposed_rule = String(parsed.proposed_rule || "").trim();
    if (!understanding || !proposed_rule) {
      return NextResponse.json(
        { detail: "Eksik understanding/proposed_rule", raw: text.slice(0, 500) },
        { status: 502 },
      );
    }
    return NextResponse.json({
      project,
      understanding,
      proposed_rule,
      tags,
      note,
      files,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const invalid =
      /API key not valid|API_KEY_INVALID|INVALID_ARGUMENT/i.test(msg);
    return NextResponse.json(
      {
        detail: invalid
          ? "GEMINI_API_KEY geçersiz — panelde yeni anahtar yapıştır (Google AI Studio). Eski/bozuk key dosyada veya oturumda kalmış olabilir."
          : msg,
      },
      { status: invalid ? 400 : 500 },
    );
  }
}
