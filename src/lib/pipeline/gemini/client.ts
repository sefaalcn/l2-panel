import { GoogleGenAI, HarmBlockThreshold, HarmCategory, ThinkingLevel } from "@google/genai";
import fs from "fs";
import { compressVideo } from "./ffmpeg";
import { encodeImage, findFramePair } from "./frames";
import { getSelfCheckInstruction, getSystemPrompt, GEMINI_MODEL } from "./prompts";
import type { ProjectPaths, SceneRow } from "./project";
import { log } from "./project";
import { isGeekFree, sceneMainTopic } from "@/lib/scenes";
import {
  formatFailLessonsForGemini,
  loadFailLessonsFromBase,
} from "@/lib/fail-lessons";
import {
  formatLearnedRulesForGemini,
  loadLearnedRulesFromBase,
} from "@/lib/learned-rules";
import { clip, fmtTime, MAX_V1, MAX_V2, MAX_V3, normalizeChar, parseJsonArray } from "./text";
import { isFreeTierQuotaError } from "./ai-client";

type Part =
  | { text: string }
  | { inlineData: { data: string; mimeType: string } }
  | { fileData: { fileUri: string; mimeType: string } };

type UploadedFile = { name?: string; uri?: string; mimeType?: string; state?: string };

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function uploadOrCache(
  client: GoogleGenAI,
  paths: ProjectPaths,
): Promise<UploadedFile> {
  if (fs.existsSync(paths.geminiCacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(paths.geminiCacheFile, "utf8")) as UploadedFile;
      if (c.name) {
        const chk = await client.files.get({ name: c.name });
        if (chk.state === "ACTIVE") {
          log("📦 Cache geçerli — yeniden yükleme yok");
          return chk;
        }
      }
    } catch {
      /* */
    }
  }

  const up = await compressVideo(paths.videoPath);
  const stat = fs.statSync(up);
  log(`📤 Yükleniyor: ${up} (${(stat.size / 1e6).toFixed(1)} MB)...`);
  let f: UploadedFile | null = null;
  const backoffs = [5, 15, 30, 60];
  for (let attempt = 1; attempt <= backoffs.length + 1; attempt++) {
    try {
      f = await client.files.upload({
        file: up,
        config: { mimeType: "video/mp4" },
      });
      break;
    } catch (e) {
      const err = e as { message?: string; cause?: { code?: string; message?: string } };
      const msg = err?.message || String(e);
      const cause = err?.cause;
      const causeStr = cause ? ` (cause: ${cause.code || ""} ${cause.message || ""})`.trim() : "";
      if (attempt > backoffs.length) {
        throw new Error(`Gemini upload başarısız: ${msg}${causeStr}`);
      }
      const wait = backoffs[attempt - 1];
      log(`   ⚠️ upload denemesi ${attempt} başarısız: ${msg}${causeStr} — ${wait}s bekleyip tekrar...`);
      await sleep(wait * 1000);
    }
  }
  if (!f) throw new Error("Gemini upload: yanıt yok");
  while (true) {
    const chk = await client.files.get({ name: f.name! });
    if (chk.state === "ACTIVE") {
      f = chk;
      break;
    }
    if (chk.state === "FAILED") throw new Error("Gemini upload FAILED");
    await sleep(5000);
  }
  fs.writeFileSync(
    paths.geminiCacheFile,
    JSON.stringify({ name: f.name, uri: f.uri, mime_type: f.mimeType }),
    "utf8",
  );
  log("   ✅ Video hazır");
  return f;
}

async function buildParts(
  vid: UploadedFile,
  scenes: SceneRow[],
  videoContext: string,
  charRefs: { name: string; data: Buffer }[],
  paths: ProjectPaths,
  swapOn: boolean,
  withImages: boolean,
  soften: boolean,
  geekFree = false,
  translateV3 = false,
): Promise<Part[]> {
  const parts: Part[] = [];
  if (vid.uri && vid.mimeType) {
    parts.push({ fileData: { fileUri: vid.uri, mimeType: vid.mimeType } });
  }

  let intro =
    geekFree
      ? "GEEKFREE MODE — watch ONLY the scene(s) below (their time range). " +
        "Maximum child-friendly CARTOON GEEK is REQUIRED in v1 ONLY:\n" +
        "  • v1 = ONE continuous optimizer action WITH exactly ONE geek touch woven into that same motion " +
        "(one in-frame symbol OR one small acting gag — NOT both; single beat, one movement)\n" +
        "  • v2 = slow-motion main action (same rules as normal v2 — NOT a frozen face shot)\n" +
        "  • v3 = see the v3 instruction below (translation mode) — NOT a gag\n" +
        "Pick symbols from the verb→effect pool (sleep→Zzz, surprise→!, confuse→?, love→heart, " +
        "shout→sound-waves, idea→light-bulb, stress→sweat).\n\n"
      : "VIDEO CONTEXT (what this whole video is about — use it to judge each scene's role, tone and " +
        "which character is which):\n" +
        (videoContext.trim() || "(no context provided)") +
        "\n\nWatch these scenes and write v1/v2/v3 for each, in the optimizer-friendly single-action " +
        "cinematic style. Honor each user note's intent and specific verbs, take the real motion from " +
        "the video. Use the context above to get the EMOTION and STORY ROLE of each scene right.";

  if (geekFree && videoContext.trim()) {
    intro += "VIDEO CONTEXT (story/tone reference):\n" + videoContext.trim() + "\n\n";
  }

  if (translateV3) {
    intro +=
      "\n\n⚠️ V3 OVERRIDE FOR THIS RUN (replaces the system-prompt v3 definition):\n" +
      "v3 = the creator's user note translated FAITHFULLY into natural English.\n" +
      "  • LITERAL translation of the creator's intent — keep every element, verb and detail exactly as written\n" +
      "  • do NOT optimize, do NOT add camera brackets, symbols, gags, effects or a style tag\n" +
      "  • do NOT add anything that is not in the note; do NOT drop anything that is\n" +
      "  • plain natural English sentences, nothing else";
  }

  if (soften) {
    intro +=
      "\nIMPORTANT: This is a wholesome, age-appropriate children's cartoon (like CoComelon). " +
      "Any 'anger/crying/scolding' is GENTLE, cartoonish and mild.\n";
  }
  if (withImages) {
    intro +=
      "\nFor EACH scene the START frame image is attached — STUDY it." +
      " If frame_mode=both, an END frame is also attached: the action MUST land in that exact end pose;" +
      " end v1/v2 with an explicit 'ending …' clause matching the END image.";
    if (swapOn) {
      intro +=
        "\nSome scenes also include the ORIGINAL (pre-swap) frame for identity mapping only.";
    }
  } else {
    intro += "\nJudge face_visible from the video itself.";
  }

  const learnedBlock = formatLearnedRulesForGemini(loadLearnedRulesFromBase(paths.base));
  if (learnedBlock) {
    intro += "\n\n" + learnedBlock;
  }
  const failBlock = formatFailLessonsForGemini(loadFailLessonsFromBase(paths.base));
  if (failBlock) {
    intro += "\n\n" + failBlock;
  }
  parts.push({ text: intro });

  if (charRefs.length) {
    parts.push({
      text:
        "\n=== CHARACTER REFERENCES (the TRUE current look of each character) ===\n" +
        "Take APPEARANCE from these references — MOTION from the video.",
    });
    for (const ref of charRefs) {
      parts.push({ text: `\nReference — "${ref.name}":` });
      parts.push({
        inlineData: { data: ref.data.toString("base64"), mimeType: "image/jpeg" },
      });
    }
    parts.push({ text: "\n=== END REFERENCES ===\n" });
  }

  for (const s of scenes) {
    const note = normalizeChar(String(s.scene_description || "").trim());
    const fs_ = s.frame_first_seek as number | undefined;
    const ls = s.frame_last_seek as number | undefined;
    const st = fs_ ?? ls ?? 0;
    const en = ls ?? fs_ ?? 0;
    const fm = String(s.frame_mode || "both");
    const label = String(s.label || `scene_${String(s.index).padStart(3, "0")}`);
    const ftype: "first" | "last" = fm === "end_only" ? "last" : "first";
    let noteLine = note;
    if (soften) noteLine += "  (render this emotion in a gentle, child-friendly, cartoonish way)";
    const topic = sceneMainTopic(s);
    if (isGeekFree(s)) {
      noteLine +=
        `\n  [GEEKFREE=true — cartoon geek ZORUNLU; scene_main_topic: "${topic || "(scene_description'dan çıkar)"}"]`;
    } else if (topic) {
      noteLine += `\n  scene_main_topic: "${topic}"`;
    }
    parts.push({
      text: `\nSCENE ${String(s.index).padStart(3, "0")} [${fmtTime(Number(st))}→${fmtTime(Number(en))}] [frame_mode: ${fm}]\n  user note (intent): "${noteLine}"`,
    });

    if (withImages) {
      const { swap: fpSwap, orig: fpOrig } = findFramePair(paths, label, ftype, swapOn);
      if (fpSwap) {
        const b64 = await encodeImage(fpSwap);
        if (b64) {
          parts.push({
            text: fpOrig
              ? "  START frame — TRUE look for Hailuo:"
              : "  START frame for this scene:",
          });
          parts.push({
            inlineData: { data: b64.toString("base64"), mimeType: "image/jpeg" },
          });
        }
      }
      if (fpOrig) {
        const b64o = await encodeImage(fpOrig);
        if (b64o) {
          parts.push({
            text:
              "  ORIGINAL video frame (OLD look) — identity mapping ONLY, never describe this look:",
          });
          parts.push({
            inlineData: { data: b64o.toString("base64"), mimeType: "image/jpeg" },
          });
        }
      }
      // both: END frame — landing pose Gemini must write into "ending …"
      if (fm === "both") {
        const { swap: endSwap } = findFramePair(paths, label, "last", swapOn);
        if (endSwap && endSwap !== fpSwap) {
          const b64e = await encodeImage(endSwap);
          if (b64e) {
            parts.push({
              text:
                "  END frame (LANDING TARGET) — v1/v2 MUST finish in this exact pose; write 'ending …' to match:",
            });
            parts.push({
              inlineData: { data: b64e.toString("base64"), mimeType: "image/jpeg" },
            });
          }
        }
      }
    }
  }

  parts.push({ text: "\nReturn ONLY the JSON array." });
  return parts;
}

export async function genBatch(
  client: GoogleGenAI,
  vid: UploadedFile,
  scenes: SceneRow[],
  paths: ProjectPaths,
  videoContext: string,
  charRefs: { name: string; data: Buffer }[],
  swapOn: boolean,
  geekFree = false,
  translateV3 = false,
): Promise<Record<string, unknown>[] | null> {
  let lastErr: unknown = null;
  const modes: [boolean, boolean, string][] = [
    [true, false, "görselli"],
    [false, false, "GÖRSELSİZ (fallback)"],
    [false, true, "GÖRSELSİZ+YUMUŞAK (kurtarma)"],
  ];

  for (const [withImages, soften, mode] of modes) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parts = await buildParts(
          vid,
          scenes,
          videoContext,
          charRefs,
          paths,
          swapOn,
          withImages,
          soften,
          geekFree,
          translateV3,
        );
        const resp = await client.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: getSystemPrompt(),
            temperature: 0.4,
            maxOutputTokens: 20000,
            safetySettings: SAFETY,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });
        const raw = resp.text;
        if (!raw) {
          const pf = String(resp.promptFeedback || "");
          const blocked = pf.includes("PROHIBITED") || pf.includes("BLOCK");
          log(`   ⚠️ boş yanıt (${mode}, ${attempt + 1}/2) feedback=${pf}`);
          if (blocked) break;
          await sleep(5000);
          continue;
        }
        const parsed = parseJsonArray(raw);
        if (parsed) {
          if (soften) log("   ✓ yumuşak kurtarma başarılı");
          else if (!withImages) log("   ✓ görselsiz fallback başarılı");
          return parsed;
        }
        log(`   ⚠️ JSON parse olmadı (${mode}, ${attempt + 1}/2)`);
        await sleep(5000);
      } catch (e) {
        lastErr = e;
        log(`   ⚠️ ${mode} deneme ${attempt + 1}/2 hata: ${e}`);
        if (isFreeTierQuotaError(e)) throw e;
        await sleep(5000);
      }
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

const ALT_V1_SYSTEM =
  "You are a Hailuo I2V prompt engineer. The user already has a base prompt (v1) from scene_description. " +
  "Watch ONLY the scene time range provided. Write ONE alternate English Hailuo prompt (v2) — same action and intent, " +
  "different cinematic wording. Start with a Hailuo camera bracket tag. ONE continuous motion. ≤460 chars. " +
  'Return ONLY JSON: {"v2":"..."}';

const GEEK_SYSTEM =
  "You are a cartoon geek effect writer for Hailuo I2V. Watch ONLY this scene's time range. " +
  "Write an English ADDON snippet (not a full prompt) with child-friendly cartoon geek: " +
  "in-frame symbols (Zzz, !, heart, sparkle, sweat…) + one acting gag gesture. " +
  "This text will be APPENDED to the base prompt. ≤220 chars. " +
  'Return ONLY JSON: {"geek":"..."}';

async function genSingleSceneJson(
  client: GoogleGenAI,
  vid: UploadedFile,
  scene: SceneRow,
  paths: ProjectPaths,
  videoContext: string,
  charRefs: { name: string; data: Buffer }[],
  swapOn: boolean,
  systemInstruction: string,
  userIntro: string,
  resultKey: "v2" | "geek",
): Promise<string | null> {
  const parts: Part[] = [];
  if (vid.uri && vid.mimeType) {
    parts.push({ fileData: { fileUri: vid.uri, mimeType: vid.mimeType } });
  }
  parts.push({ text: userIntro });

  const s = scene;
  const note = normalizeChar(String(s.scene_description || "").trim());
  const fs_ = s.frame_first_seek as number | undefined;
  const ls = s.frame_last_seek as number | undefined;
  const st = fs_ ?? ls ?? 0;
  const en = ls ?? fs_ ?? 0;
  const fm = String(s.frame_mode || "both");
  const label = String(s.label || `scene_${String(s.index).padStart(3, "0")}`);
  const ftype: "first" | "last" = fm === "end_only" ? "last" : "first";

  parts.push({
    text:
      `\nSCENE ${String(s.index).padStart(3, "0")} [${fmtTime(Number(st))}→${fmtTime(Number(en))}] [frame_mode: ${fm}]\n` +
      `  scene_description: "${note}"`,
  });

  const { swap: fpSwap } = findFramePair(paths, label, ftype, swapOn);
  if (fpSwap) {
    const b64 = await encodeImage(fpSwap);
    if (b64) {
      parts.push({ text: "  START frame:" });
      parts.push({ inlineData: { data: b64.toString("base64"), mimeType: "image/jpeg" } });
    }
  }
  parts.push({ text: `\nReturn ONLY JSON with "${resultKey}" field.` });

  const resp = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction,
      temperature: 0.4,
      maxOutputTokens: 4000,
      safetySettings: SAFETY,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });
  const raw = resp.text;
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const parsed = JSON.parse(m[0]) as Record<string, string>;
  const val = String(parsed[resultKey] || "").trim();
  return val || null;
}

export async function genAltV1(
  client: GoogleGenAI,
  vid: UploadedFile,
  scene: SceneRow,
  paths: ProjectPaths,
  videoContext: string,
  charRefs: { name: string; data: Buffer }[],
  swapOn: boolean,
  basePrompt: string,
): Promise<string | null> {
  const intro =
    "Watch ONLY this scene. The base prompt (v1) is already set from scene_description:\n" +
    `"${basePrompt.slice(0, 500)}"\n\n` +
    (videoContext.trim() ? `Context:\n${videoContext.trim().slice(0, 600)}\n\n` : "") +
    "Write v2 — an alternate Hailuo prompt for the SAME action.";
  const v2 = await genSingleSceneJson(
    client,
    vid,
    scene,
    paths,
    videoContext,
    charRefs,
    swapOn,
    ALT_V1_SYSTEM,
    intro,
    "v2",
  );
  return v2 ? clip(normalizeChar(v2), MAX_V1, true, true) : null;
}

export async function genGeekAddon(
  client: GoogleGenAI,
  vid: UploadedFile,
  scene: SceneRow,
  paths: ProjectPaths,
  videoContext: string,
  charRefs: { name: string; data: Buffer }[],
  swapOn: boolean,
  basePrompt: string,
  mainTopic: string,
): Promise<string | null> {
  const intro =
    "GEEKFREE — watch ONLY this scene time range.\n" +
    `Base prompt (will be sent as-is + your geek addon):\n"${basePrompt.slice(0, 500)}"\n` +
    (mainTopic ? `scene_main_topic: "${mainTopic}"\n` : "") +
    "Write the geek addon to append for maximum cartoon geek effect.";
  const geek = await genSingleSceneJson(
    client,
    vid,
    scene,
    paths,
    videoContext,
    charRefs,
    swapOn,
    GEEK_SYSTEM,
    intro,
    "geek",
  );
  return geek ? clip(normalizeChar(geek), 220, false, true) : null;
}

export async function selfCheck(
  client: GoogleGenAI,
  entry: Record<string, unknown>,
  faceVis: boolean,
  videoChars: string,
  failLessons = "",
): Promise<{ entry: Record<string, unknown>; changed: string[] }> {
  let ctx = "";
  if (videoChars) {
    ctx += `CHARACTERS (TRUE current appearance):\n${videoChars.slice(0, 800)}\n\n`;
  }
  if (failLessons.trim()) {
    ctx += failLessons.trim().slice(0, 2000) + "\n\n";
  }
  const note = String(entry.scene_desc || "").trim();
  if (note) ctx += `Scene user note: "${note.slice(0, 300)}"\n\n`;
  const inp =
    ctx +
    `frame_mode: ${entry.frame_mode}\nface_visible: ${faceVis}\n\n` +
    `v1: ${entry.v1}\nv2: ${entry.v2}\nv3: ${entry.v3}\n\n` +
    "Check against the rules and return ONLY the corrected JSON.";

  try {
    const resp = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts: [{ text: inp }] }],
      config: {
        systemInstruction: getSelfCheckInstruction(),
        temperature: 0.2,
        maxOutputTokens: 4000,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const raw = resp.text;
    if (!raw) return { entry, changed: [] };
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { entry, changed: [] };
    const fixed = JSON.parse(m[0]) as Record<string, unknown>;
    const changed: string[] = [];
    for (const k of ["v1", "v2", "v3"] as const) {
      if (k in fixed && fixed[k] !== entry[k]) changed.push(k);
      if (k in fixed) entry[k] = fixed[k];
    }
    if ("face_visible" in fixed) {
      const fv = fixed.face_visible;
      entry.face_visible =
        typeof fv === "boolean" ? fv : !["false", "no", "0"].includes(String(fv).toLowerCase());
    }
    return { entry, changed };
  } catch (e) {
    log(`   ⚠️ self-check atlandı: ${e}`);
    return { entry, changed: [] };
  }
}

export { clip, MAX_V1, MAX_V2, MAX_V3, normalizeChar };
