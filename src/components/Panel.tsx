"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ModelCred = { key: string; label: string; secret: boolean; required: boolean; autoFromFile?: boolean };
type ModelDef = {
  label: string;
  active: boolean;
  credentials: ModelCred[];
  options: { key: string; label: string; type: string; default?: boolean; note?: string }[];
};
type Project = {
  name: string;
  scene_count: number | null;
  version: number | string | null;
  has_keyframes: boolean;
  has_keyframes_swapped?: boolean;
  keyframes_source?: "original" | "swapped";
  has_prompts: boolean;
};

type KeyframesSource = "original" | "swapped";

function FileDrop({
  label,
  hint,
  file,
  accept,
  onFile,
}: {
  label: string;
  hint: string;
  file: File | null;
  accept: string;
  onFile: (f: File | null) => void;
}) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop drop-sm${over ? " over" : ""}`}
      onClick={() => ref.current?.click()}
      onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <strong>{label}</strong>
      <span className="hint">{hint}</span>
      <div className="files">
        <div>{file ? `✓ ${file.name}` : "dosya seç veya bırak"}</div>
      </div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => onFile(e.target.files?.[0] || null)}
      />
    </div>
  );
}

async function jget<T>(u: string): Promise<T> {
  const r = await fetch(u);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { detail?: string }).detail || String(r.status));
  return d as T;
}
async function jpost<T>(u: string, b: unknown): Promise<{ ok: boolean; status: number; d: T }> {
  const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const d = (await r.json().catch(() => ({}))) as T;
  return { ok: r.ok, status: r.status, d };
}

function mask(v: string) {
  if (!v) return "";
  if (v.length <= 10) return v;
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function CollapsibleFld({
  id,
  title,
  badge,
  open,
  onToggle,
  children,
  optional,
  optionalOn,
  onOptionalChange,
  optionalLabel = "Kullan",
}: {
  id: string;
  title: string;
  badge?: ReactNode;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
  optional?: boolean;
  optionalOn?: boolean;
  onOptionalChange?: (v: boolean) => void;
  optionalLabel?: string;
}) {
  return (
    <div className="collapse-fld">
      <button type="button" className="collapse-hd" onClick={() => onToggle(id)} aria-expanded={open}>
        <span className="collapse-title">{title}</span>
        {badge}
        {optional && (
          <label className="collapse-opt" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={optionalOn}
              onChange={(e) => onOptionalChange?.(e.target.checked)}
            />
            {optionalLabel}
          </label>
        )}
        <span className="collapse-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="collapse-bd">{children}</div>}
    </div>
  );
}

function StartConfirmModal({
  open,
  onCancel,
  onConfirm,
  summary,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  summary: {
    project: string;
    scenes: number | null;
    keyframes: string;
    variants: string;
    totalVideos: number | null;
    scenario: string;
    concurrency: number;
    promptOptimizer: boolean;
    regenPrompts: boolean;
  };
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>Koşuyu başlat</h3>
        <dl className="modal-dl">
          <div><dt>Proje</dt><dd>{summary.project}</dd></div>
          <div><dt>Sahne</dt><dd>{summary.scenes ?? "—"}</dd></div>
          <div><dt>Keyframes</dt><dd>{summary.keyframes}</dd></div>
          <div><dt>Varyantlar</dt><dd>{summary.variants || "—"}</dd></div>
          {summary.totalVideos != null && (
            <div><dt>Toplam video</dt><dd>{summary.totalVideos}</dd></div>
          )}
          <div><dt>Senaryo</dt><dd>{summary.scenario}</dd></div>
          <div><dt>Hailuo Optimizer</dt><dd>{summary.promptOptimizer ? "Açık" : "Kapalı (verbatim)"}</dd></div>
          <div>
            <dt>Promptlar</dt>
            <dd>{summary.regenPrompts ? "Baştan yeniden üret (Gemini)" : "Mevcut + eksikleri tamamla"}</dd>
          </div>
          <div><dt>Eşzamanlılık</dt><dd>{summary.concurrency}</dd></div>
        </dl>
        <div className="modal-actions">
          <button type="button" className="modal-cancel" onClick={onCancel}>İptal</button>
          <button type="button" className="modal-confirm" onClick={onConfirm}>Başlat</button>
        </div>
      </div>
    </div>
  );
}

const VARIANT_KEYS = ["v1", "v2", "v3", "v4"] as const;
type VariantKey = (typeof VARIANT_KEYS)[number];

const VARIANT_LABELS: Record<VariantKey, string> = {
  v1: "v1 — ana hareket (Hailuo optimizer açık)",
  v2: "v2 — slow motion (Hailuo optimizer açık)",
  v3: "v3 — orijinal EN çeviri (Hailuo optimizer kapalı)",
  v4: "v4 — geekfree ekstra (Hailuo optimizer açık)",
};

export default function Panel() {
  const [models, setModels] = useState<Record<string, ModelDef>>({});
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [optimizer, setOptimizer] = useState(true);
  const [regenPrompts, setRegenPrompts] = useState(false);
  const [variantSel, setVariantSel] = useState<Record<VariantKey, boolean>>({
    v1: true,
    v2: true,
    v3: true,
    v4: false,
  });
  const [concurrency, setConcurrency] = useState(2);
  const [variantsSummary, setVariantsSummary] = useState("");
  const [totalVideos, setTotalVideos] = useState<number | null>(null);
  const [scenario, setScenario] = useState<string | null>(null);
  const [needsGemini, setNeedsGemini] = useState(false);
  const [needsHailuo, setNeedsHailuo] = useState(true);
  const [needsFirefly, setNeedsFirefly] = useState(false);
  const [fireflyModels, setFireflyModels] = useState<string[]>([]);
  const [hailuoSceneCount, setHailuoSceneCount] = useState<number | null>(null);
  const [fireflySceneCount, setFireflySceneCount] = useState<number | null>(null);
  const [outputs, setOutputs] = useState<
    { name: string; size_label: string; scene: string | null; variant: string | null; download_url: string }[]
  >([]);
  const [outputFolder, setOutputFolder] = useState("hailuo_router_videos/");
  const [outputsLoading, setOutputsLoading] = useState(false);
  const [failByFile, setFailByFile] = useState<
    Record<string, { tags: string[]; note?: string }>
  >({});
  const [failTagMeta, setFailTagMeta] = useState<{ key: string; label: string }[]>([]);
  const [failSelected, setFailSelected] = useState<Record<string, boolean>>({});
  const [failPickTags, setFailPickTags] = useState<Record<string, boolean>>({});
  const [failNote, setFailNote] = useState("");
  const [failBusy, setFailBusy] = useState(false);
  const [failMsg, setFailMsg] = useState("");
  const [ruleModal, setRuleModal] = useState<{
    understanding: string;
    proposed_rule: string;
    tags: string[];
    note: string;
    files: { file: string; scene: string | null; variant: string | null }[];
  } | null>(null);
  const [ruleRefine, setRuleRefine] = useState("");
  const [learnedCount, setLearnedCount] = useState({ must: 0, soft: 0 });
  const [preflightTxt, setPreflightTxt] = useState("");
  const [tokMsg, setTokMsg] = useState("");
  const [tokOk, setTokOk] = useState<boolean | null>(null);
  const [ffTokMsg, setFfTokMsg] = useState("");
  const [ffTokOk, setFfTokOk] = useState<boolean | null>(null);
  const [startMsg, setStartMsg] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [liveTxt, setLiveTxt] = useState("boşta");
  const [liveOn, setLiveOn] = useState(false);
  const [progress, setProgress] = useState<Record<string, unknown> | null>(null);
  const [dropScenes, setDropScenes] = useState<File | null>(null);
  const [dropZip, setDropZip] = useState<File | null>(null);
  const [dropVideo, setDropVideo] = useState<File | null>(null);
  const [uploadSource, setUploadSource] = useState<KeyframesSource>("original");
  const [keyframesSource, setKeyframesSource] = useState<KeyframesSource>("original");
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const [credFound, setCredFound] = useState<Record<string, boolean>>({});
  const [cookieMsg, setCookieMsg] = useState("");
  const [cookieOk, setCookieOk] = useState<boolean | null>(null);
  const [cookieValid, setCookieValid] = useState<boolean | null>(null);
  const [cookiePaste, setCookiePaste] = useState("");
  const [cookieSaveMsg, setCookieSaveMsg] = useState("");
  const [projectSaveMsg, setProjectSaveMsg] = useState("");
  const [ffTokenSaveMsg, setFfTokenSaveMsg] = useState("");
  const [geminiSaveMsg, setGeminiSaveMsg] = useState("");
  const [geminiSavedMask, setGeminiSavedMask] = useState("");
  const [openFields, setOpenFields] = useState<Record<string, boolean>>({});
  const [useAnthropic, setUseAnthropic] = useState(false);
  const [apiKeys, setApiKeys] = useState({ GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sceneCount, setSceneCount] = useState<number | null>(null);
  const [geekfreeSceneCount, setGeekfreeSceneCount] = useState<number>(0);
  const [expiryWarnings, setExpiryWarnings] = useState<{ label: string; message: string }[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const geminiInputRef = useRef<HTMLInputElement>(null);
  const anthropicInputRef = useRef<HTMLInputElement>(null);

  const toggleField = useCallback((id: string) => {
    setOpenFields((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const hailuoModel = models.hailuo;
  const hybridRun = needsHailuo && needsFirefly;
  const fireflyOnly = needsFirefly && !needsHailuo;
  const effectiveConcurrency = fireflyOnly ? 1 : concurrency;

  const selectedVariants = useMemo(
    () => VARIANT_KEYS.filter((k) => variantSel[k]),
    [variantSel],
  );
  const variantsParam = selectedVariants.join(",");

  const mergeCreds = useCallback((prev: Record<string, string>, incoming: Record<string, string>) => {
    const next = { ...prev };
    for (const [k, v] of Object.entries(incoming)) {
      if (v?.trim() && !prev[k]?.trim()) next[k] = v.trim();
    }
    return next;
  }, []);

  const loadCredentials = useCallback(async (projectName?: string) => {
    const q = projectName ? `?project=${encodeURIComponent(projectName)}` : "";
    const d = await jget<{
      credentials: Record<string, string>;
      found?: Record<string, boolean>;
      cookie?: { ok: boolean; valid: boolean | null; message: string };
      expiring_soon?: { label: string; message: string }[];
    }>(`/api/credentials${q}`);
    const loaded = d.credentials || {};
    if (Object.keys(loaded).length) {
      setCreds((prev) => mergeCreds(prev, loaded));
    }
    if (d.found) setCredFound(d.found);
    if (d.cookie) {
      setCookieOk(d.cookie.ok);
      setCookieValid(d.cookie.valid);
      setCookieMsg(d.cookie.message);
    } else {
      setCookieOk(null);
      setCookieValid(null);
      setCookieMsg("");
    }
    setExpiryWarnings(d.expiring_soon || []);
  }, [mergeCreds]);

  const loadProjects = useCallback(async () => {
    const d = await jget<{ projects: Project[] }>("/api/projects");
    setProjects(d.projects || []);
  }, []);

  const loadApiKeyStatus = useCallback(async () => {
    try {
      const d = await jget<{
        keys: Record<string, { set: boolean; masked?: string }>;
      }>("/api/keys");
      const gem = d.keys?.GEMINI_API_KEY;
      const anth = d.keys?.ANTHROPIC_API_KEY;
      setEnvSet((prev) => ({
        ...prev,
        GEMINI_API_KEY: Boolean(gem?.set),
        ANTHROPIC_API_KEY: Boolean(anth?.set),
      }));
      setGeminiSavedMask(gem?.masked || "");
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    (async () => {
      const m = await jget<{ models: Record<string, ModelDef>; env_set: Record<string, boolean> }>("/api/models");
      setModels(m.models);
      setEnvSet(m.env_set || {});
      setUseAnthropic(Boolean(m.env_set?.ANTHROPIC_API_KEY));
      const opt = m.models.hailuo?.options?.find((o) => o.key === "prompt_optimizer");
      setOptimizer(opt?.default !== false);
      await loadProjects();
      await loadCredentials();
      await loadApiKeyStatus();
    })().catch(console.error);
  }, [loadProjects, loadCredentials, loadApiKeyStatus]);

  const loadOutputs = useCallback(async (projectName?: string, provider?: string) => {
    const p = projectName || project;
    if (!p) {
      setOutputs([]);
      setFailByFile({});
      setFailSelected({});
      return;
    }
    const prov = provider || (needsFirefly && !needsHailuo ? "firefly" : "hailuo");
    setOutputsLoading(true);
    try {
      const d = await jget<{
        files: { name: string; size_label: string; scene: string | null; variant: string | null; download_url: string }[];
        dir: string | null;
        output_folder?: string;
      }>(`/api/project/${encodeURIComponent(p)}/outputs?provider=${encodeURIComponent(prov)}`);
      setOutputs(d.files || []);
      if (d.output_folder) setOutputFolder(d.output_folder);
      try {
        const fl = await jget<{
          tags: { key: string; label: string }[];
          items: { file: string; tags: string[]; note?: string }[];
        }>(`/api/project/${encodeURIComponent(p)}/fail-lessons`);
        setFailTagMeta(fl.tags || []);
        const map: Record<string, { tags: string[]; note?: string }> = {};
        for (const it of fl.items || []) {
          map[it.file] = { tags: it.tags || [], note: it.note };
        }
        setFailByFile(map);
        try {
          const lr = await jget<{ must: string[]; soft: string[] }>(
            `/api/project/${encodeURIComponent(p)}/learned-rules`,
          );
          setLearnedCount({ must: lr.must?.length || 0, soft: lr.soft?.length || 0 });
        } catch {
          /* */
        }
      } catch {
        /* fail-lessons yoksa sessiz */
      }
    } catch {
      setOutputs([]);
    } finally {
      setOutputsLoading(false);
    }
  }, [project, needsFirefly, needsHailuo]);

  useEffect(() => {
    void loadOutputs(project || undefined);
  }, [project, loadOutputs]);

  const failSelectedNames = useMemo(
    () => Object.keys(failSelected).filter((k) => failSelected[k]),
    [failSelected],
  );
  const failPickTagKeys = useMemo(
    () => Object.keys(failPickTags).filter((k) => failPickTags[k]),
    [failPickTags],
  );

  const analyzeFailForRules = useCallback(async () => {
    if (!project || !failSelectedNames.length || !failPickTagKeys.length) {
      setFailMsg("En az bir video ve bir neden seç");
      return;
    }
    setFailBusy(true);
    setFailMsg("");
    setRuleModal(null);
    try {
      const files = failSelectedNames.map((name) => {
        const f = outputs.find((o) => o.name === name);
        return {
          file: name,
          scene: f?.scene ?? null,
          variant: f?.variant ?? null,
        };
      });
      const { ok, d } = await jpost<{
        detail?: string;
        understanding?: string;
        proposed_rule?: string;
        tags?: string[];
        note?: string;
        files?: { file: string; scene: string | null; variant: string | null }[];
      }>(`/api/project/${encodeURIComponent(project)}/learned-rules`, {
        action: "analyze",
        tags: failPickTagKeys,
        note: failNote.trim() || undefined,
        files,
      });
      if (!ok) throw new Error(d.detail || "Analiz başarısız");
      if (!d.understanding || !d.proposed_rule) throw new Error("Gemini özet üretemedi");
      setRuleModal({
        understanding: d.understanding,
        proposed_rule: d.proposed_rule,
        tags: d.tags || failPickTagKeys,
        note: d.note || failNote.trim(),
        files: d.files || files,
      });
      setRuleRefine("");
      setFailMsg("Gemini anladığını yazdı — popup’tan onayla veya düzelt");
    } catch (e) {
      setFailMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFailBusy(false);
    }
  }, [project, failSelectedNames, failPickTagKeys, failNote, outputs]);

  const refineRuleAnalysis = useCallback(async () => {
    if (!project || !ruleModal) return;
    if (!ruleRefine.trim()) {
      setFailMsg("Daha detaylı açıklama yaz");
      return;
    }
    setFailBusy(true);
    try {
      const { ok, d } = await jpost<{
        detail?: string;
        understanding?: string;
        proposed_rule?: string;
      }>(`/api/project/${encodeURIComponent(project)}/learned-rules`, {
        action: "refine",
        tags: ruleModal.tags,
        note: ruleModal.note,
        files: ruleModal.files,
        previous_understanding: ruleModal.understanding,
        previous_rule: ruleModal.proposed_rule,
        refine: ruleRefine.trim(),
      });
      if (!ok) throw new Error(d.detail || "Yeniden analiz başarısız");
      if (!d.understanding || !d.proposed_rule) throw new Error("Gemini özet üretemedi");
      setRuleModal({
        ...ruleModal,
        understanding: d.understanding,
        proposed_rule: d.proposed_rule,
      });
      setRuleRefine("");
      setFailMsg("Güncellendi — tekrar kontrol et");
    } catch (e) {
      setFailMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFailBusy(false);
    }
  }, [project, ruleModal, ruleRefine]);

  const approveLearnedRule = useCallback(
    async (severity: "must" | "soft") => {
      if (!project || !ruleModal) return;
      setFailBusy(true);
      try {
        const { ok, d } = await jpost<{
          detail?: string;
          message?: string;
          must?: string[];
          soft?: string[];
        }>(`/api/project/${encodeURIComponent(project)}/learned-rules`, {
          action: "approve",
          proposed_rule: ruleModal.proposed_rule,
          severity,
          tags: ruleModal.tags,
          note: ruleModal.note,
          files: ruleModal.files,
        });
        if (!ok) throw new Error(d.detail || "Kural eklenemedi");
        setLearnedCount({ must: d.must?.length || 0, soft: d.soft?.length || 0 });
        setRuleModal(null);
        setFailSelected({});
        setFailMsg(d.message || "Kural eklendi");
        await loadOutputs(project);
      } catch (e) {
        setFailMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setFailBusy(false);
      }
    },
    [project, ruleModal, loadOutputs],
  );

  const saveFailLessons = useCallback(async () => {
    if (!project || !failSelectedNames.length || !failPickTagKeys.length) {
      setFailMsg("En az bir video ve bir neden seç");
      return;
    }
    setFailBusy(true);
    setFailMsg("");
    try {
      const items = failSelectedNames.map((name) => {
        const f = outputs.find((o) => o.name === name);
        return {
          file: name,
          scene: f?.scene ?? null,
          variant: f?.variant ?? null,
          tags: failPickTagKeys,
          note: failNote.trim() || undefined,
        };
      });
      const { ok, d } = await jpost<{
        detail?: string;
        items?: { file: string; tags: string[]; note?: string }[];
      }>(`/api/project/${encodeURIComponent(project)}/fail-lessons`, { action: "upsert", items });
      if (!ok) throw new Error(d.detail || "Kayıt başarısız");
      if (Array.isArray(d.items)) {
        const full: Record<string, { tags: string[]; note?: string }> = {};
        for (const it of d.items) full[it.file] = { tags: it.tags || [], note: it.note };
        setFailByFile(full);
      }
      setFailSelected({});
      setFailMsg("Sadece işaret kaydedildi — kural için «Analiz et» kullan");
    } catch (e) {
      setFailMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFailBusy(false);
    }
  }, [project, failSelectedNames, failPickTagKeys, failNote, outputs]);

  const clearFailLessons = useCallback(async () => {
    if (!project || !failSelectedNames.length) return;
    setFailBusy(true);
    try {
      const { ok, d } = await jpost<{
        detail?: string;
        items?: { file: string; tags: string[]; note?: string }[];
      }>(`/api/project/${encodeURIComponent(project)}/fail-lessons`, {
        action: "remove",
        files: failSelectedNames,
      });
      if (!ok) throw new Error(d.detail || "Silinemedi");
      const full: Record<string, { tags: string[]; note?: string }> = {};
      for (const it of d.items || []) full[it.file] = { tags: it.tags || [], note: it.note };
      setFailByFile(full);
      setFailSelected({});
      setFailMsg("İşaret kaldırıldı");
    } catch (e) {
      setFailMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFailBusy(false);
    }
  }, [project, failSelectedNames]);

  useEffect(() => {
    if (project) void loadCredentials(project);
  }, [project, loadCredentials]);

  useEffect(() => {
    if (!cookieOk || cookieValid === false) {
      setOpenFields((prev) => ({ ...prev, cookie: true }));
    }
  }, [cookieOk, cookieValid]);

  useEffect(() => {
    if (needsFirefly && !creds.ff_token?.trim() && !credFound.ff_token) {
      setOpenFields((prev) => ({ ...prev, "cred-ff_token": true }));
    }
  }, [needsFirefly, creds.ff_token, credFound.ff_token]);

  useEffect(() => {
    if (!project) {
      setScenario(null);
      setPreflightTxt("");
      setVariantsSummary("");
      setTotalVideos(null);
      setSceneCount(null);
      setGeekfreeSceneCount(0);
      setNeedsHailuo(true);
      setNeedsFirefly(false);
      setHailuoSceneCount(null);
      setFireflySceneCount(null);
      return;
    }
    const p = projects.find((x) => x.name === project);
    if (p?.keyframes_source) setKeyframesSource(p.keyframes_source);
  }, [project, projects]);

  useEffect(() => {
    if (!project) return;
    const q = new URLSearchParams({ keyframes_source: keyframesSource });
    jget<{
      scenario: string;
      scene_count: number;
      warnings: string[];
      keyframes_source?: KeyframesSource;
      variants_summary?: string;
      total_videos?: number;
      scene_plan?: { variants?: number }[];
      needs_gemini?: boolean;
      has_firefly_scenes?: boolean;
      has_hailuo_scenes?: boolean;
      hailuo_scene_count?: number;
      firefly_scene_count?: number;
      firefly_models?: string[];
    }>(`/api/project/${encodeURIComponent(project)}/preflight?${q}`)
      .then((d) => {
        setScenario(d.scenario);
        setNeedsGemini(Boolean(d.needs_gemini));
        const ff = Boolean(d.has_firefly_scenes);
        const hl =
          typeof d.has_hailuo_scenes === "boolean"
            ? d.has_hailuo_scenes
            : (d.hailuo_scene_count ?? Math.max(0, (d.scene_count || 0) - (d.firefly_scene_count || 0))) > 0;
        setNeedsFirefly(ff);
        setNeedsHailuo(hl || (!ff && (d.scene_count || 0) > 0));
        setFireflyModels(d.firefly_models || []);
        setHailuoSceneCount(d.hailuo_scene_count ?? null);
        setFireflySceneCount(d.firefly_scene_count ?? null);
        setSceneCount(d.scene_count ?? null);
        const scLbl: Record<string, string> = {
          A: "Senaryo A (scene_description → JSON video_model)",
          B: "Senaryo B (Gemini videodan üretecek)",
          "B-eksik": "Senaryo B — EKSİK (video yok)",
        };
        const w = d.warnings || [];
        const src = keyframesSource === "swapped" ? "swapped" : "original";
        const routeBits: string[] = [];
        if (hl || (!ff && (d.scene_count || 0) > 0)) {
          routeBits.push(`${d.hailuo_scene_count ?? "?"}×Hailuo`);
        }
        if (ff) {
          routeBits.push(
            `${d.firefly_scene_count ?? "?"}×${d.firefly_models?.length ? d.firefly_models.join("/") : "Firefly"}`,
          );
        }
        setPreflightTxt(
          `${d.scene_count} sahne · ${scLbl[d.scenario] || ""} · kf=${src}` +
            (routeBits.length ? ` · ${routeBits.join(" + ")}` : "") +
            (w.length ? ` · ⚠ ${w.length} uyarı` : ""),
        );
        const geek = (d.scene_plan || []).filter((r) => Number(r.variants) === 4).length;
        setGeekfreeSceneCount(geek);
      })
      .catch(() => setScenario(null));
  }, [project, keyframesSource]);

  useEffect(() => {
    if (sceneCount == null) {
      setTotalVideos(null);
      setVariantsSummary("");
      return;
    }

    const hasV4 = selectedVariants.includes("v4");
    const core = selectedVariants.filter((v) => v !== "v4");
    const coreCount = core.length;
    const total = sceneCount * coreCount + (hasV4 ? geekfreeSceneCount : 0);
    setTotalVideos(total);

    if (!selectedVariants.length) {
      setVariantsSummary("varyant seçilmedi");
      return;
    }

    if (hasV4) {
      if (!coreCount) {
        setVariantsSummary(`${geekfreeSceneCount}×v4 (geekfree)`);
      } else if (coreCount === 3) {
        setVariantsSummary(`${sceneCount} sahne × v1+v2+v3 + ${geekfreeSceneCount}×v4`);
      } else {
        setVariantsSummary(`${sceneCount} sahne × ${core.join("+")} + ${geekfreeSceneCount}×v4`);
      }
    } else {
      setVariantsSummary(
        selectedVariants.length === 3
          ? `${sceneCount} sahne × v1+v2+v3`
          : `${sceneCount} sahne × ${selectedVariants.join("+")}`,
      );
    }
  }, [sceneCount, selectedVariants, geekfreeSceneCount]);

  useEffect(() => {
    if (!project) {
      setExpiryWarnings([]);
      return;
    }
    const id = setInterval(() => void loadCredentials(project), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [project, loadCredentials]);

  const pmeta = projects.find((p) => p.name === project);

  const missing = useMemo(() => {
    const out: string[] = [];
    if (!project) out.push("Üretilecek Proje seç");
    if (!selectedVariants.length) out.push("En az bir varyant seç (v1/v2/v3/v4)");

    if (needsHailuo) {
      for (const cr of hailuoModel?.credentials || []) {
        if (cr.autoFromFile) {
          if (cr.required && !credFound[cr.key]) out.push(`${cr.label} (dosya)`);
          else if (cr.key === "cookie" && credFound.cookie && cookieValid === false) {
            out.push("Hailuo Cookie süresi dolmuş");
          }
        } else if (cr.required && !creds[cr.key]?.trim()) {
          out.push(cr.label);
        }
      }
    }
    if (needsFirefly) {
      if (!creds.ff_token?.trim() && !credFound.ff_token) {
        out.push("Firefly Curl (JSON video_model sahneleri)");
      }
    }
    if (
      (regenPrompts || !pmeta?.has_prompts) &&
      needsGemini &&
      !envSet.GEMINI_API_KEY &&
      !apiKeys.GEMINI_API_KEY.trim()
    ) {
      out.push("GEMINI_API_KEY yok (v1/v2 üretimi)");
    }
    if (scenario === "B-eksik") out.push("proje eksik: scene_description yok ve kaynak video yok");
    if (project && keyframesSource === "swapped" && !pmeta?.has_keyframes_swapped) {
      out.push("Swapped seçili ama keyframes_swapped yok — ZIP'i Swapped olarak yükle");
    }
    if (project && keyframesSource === "original" && !pmeta?.has_keyframes) {
      out.push("Orijinal seçili ama keyframes yok — ZIP'i Orijinal olarak yükle");
    }
    for (const w of expiryWarnings) out.push(`⚠ ${w.message}`);
    return out;
  }, [
    project,
    selectedVariants,
    needsHailuo,
    needsFirefly,
    hailuoModel,
    creds,
    credFound,
    cookieValid,
    scenario,
    needsGemini,
    envSet,
    apiKeys,
    expiryWarnings,
    regenPrompts,
    pmeta?.has_prompts,
    pmeta?.has_keyframes,
    pmeta?.has_keyframes_swapped,
    keyframesSource,
  ]);

  function guessProjectName(f: File) {
    return f.name
      .replace(/\.[^.]+$/, "")
      .replace(/_scenes_manual$/i, "")
      .replace(/_scenes$/i, "")
      .replace(/_keyframes_swapped$/i, "")
      .replace(/_keyframes$/i, "");
  }

  const derivedProject = useMemo(() => {
    if (dropScenes) return guessProjectName(dropScenes);
    if (dropZip) return guessProjectName(dropZip);
    if (dropVideo) return guessProjectName(dropVideo);
    return "";
  }, [dropScenes, dropZip, dropVideo]);

  async function doUpload() {
    const name = derivedProject.trim();
    if (!name || !dropScenes || !dropZip) return;
    setUploading(true);
    setUploadMsg("");
    const totalMb =
      (dropScenes.size + dropZip.size + (dropVideo?.size || 0)) / (1024 * 1024);
    try {
      const fd = new FormData();
      fd.append("project", name);
      fd.append("scenes", dropScenes);
      fd.append("keyframes_zip", dropZip);
      fd.append("keyframes_source", uploadSource);
      if (dropVideo) fd.append("video", dropVideo);
      const r = await fetch("/api/ingest", { method: "POST", body: fd });
      let d: { detail?: string; error?: string; project?: string; keyframes_source?: string };
      try {
        d = await r.json();
      } catch {
        const hint =
          r.status === 500
            ? "Dev sunucu bozulmuş olabilir — terminalde Ctrl+C, sonra npm run dev"
            : r.status === 413
              ? "Dosya çok büyük (413)"
              : `Toplam ~${totalMb.toFixed(1)} MB`;
        throw new Error(
          r.status
            ? `Sunucu yanıtı okunamadı (HTTP ${r.status}). ${hint}`
            : "Sunucuya ulaşılamadı — panel http://localhost:3000 adresinde mi?",
        );
      }
      if (!r.ok) {
        const msg = d.detail || d.error;
        if (msg && msg.toLowerCase() !== "internal server error") throw new Error(msg);
        throw new Error(
          msg === "Internal Server Error"
            ? "Sunucu hatası — dev sunucuyu yeniden başlatın (npm run dev)"
            : `HTTP ${r.status}`,
        );
      }
      setUploadMsg(`✓ ${d.project} yüklendi (${d.keyframes_source || uploadSource})`);
      setDropScenes(null);
      setDropZip(null);
      setDropVideo(null);
      setKeyframesSource(uploadSource);
      await loadProjects();
      setProject(d.project || name);
      await loadCredentials(d.project || name);
    } catch (e) {
      setUploadMsg(`Yükleme hatası: ${e instanceof Error ? e.message : e}`);
    } finally {
      setUploading(false);
    }
  }

  const keyTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function onKey(k: "GEMINI_API_KEY" | "ANTHROPIC_API_KEY", v: string) {
    setApiKeys((prev) => ({ ...prev, [k]: v }));
    if (k === "GEMINI_API_KEY") return;
    clearTimeout(keyTimers.current[k]);
    if (!v.trim()) return;
    keyTimers.current[k] = setTimeout(async () => {
      const { d } = await jpost<Record<string, boolean>>("/api/keys", { [k]: v });
      setEnvSet((prev) => ({ ...prev, ...d }));
    }, 400);
  }

  async function saveGeminiKeyFile() {
    setGeminiSaveMsg("");
    const v = (geminiInputRef.current?.value ?? apiKeys.GEMINI_API_KEY).trim();
    if (!v) {
      setGeminiSaveMsg("API key boş");
      return;
    }
    const { ok, d } = await jpost<{ detail?: string; length?: number }>("/api/save-gemini-key", {
      value: v,
    });
    if (!ok) {
      setGeminiSaveMsg((d as { detail?: string }).detail || "kaydedilemedi");
      return;
    }
    setGeminiSaveMsg(`✓ gemini_api_key.txt kaydedildi (${(d as { length?: number }).length} karakter)`);
    setApiKeys((prev) => ({ ...prev, GEMINI_API_KEY: "" }));
    await loadApiKeyStatus();
  }

  async function flushApiKeys() {
    const gemini = (geminiInputRef.current?.value ?? apiKeys.GEMINI_API_KEY).trim();
    const anthropic = (anthropicInputRef.current?.value ?? apiKeys.ANTHROPIC_API_KEY).trim();
    const toSave: Record<string, string> = {};
    if (gemini.length >= 20) toSave.GEMINI_API_KEY = gemini;
    if (useAnthropic && anthropic) toSave.ANTHROPIC_API_KEY = anthropic;
    if (Object.keys(toSave).length) {
      const { d } = await jpost<Record<string, boolean>>("/api/keys", toSave);
      setEnvSet((prev) => ({ ...prev, ...d }));
    }
    return toSave;
  }

  useEffect(() => {
    const t = creds.token?.trim();
    if (!t) {
      setTokMsg("");
      setTokOk(null);
      return;
    }
    const id = setTimeout(async () => {
      const { d } = await jpost<{ valid: boolean | null; message: string; expiring_soon?: boolean }>(
        "/api/check-token",
        { value: t },
      );
      setTokOk(d.expiring_soon ? false : d.valid);
      setTokMsg(d.message);
    }, 400);
    return () => clearTimeout(id);
  }, [creds.token]);

  useEffect(() => {
    const t = creds.ff_token?.trim();
    if (!t) {
      setFfTokMsg(credFound.ff_token ? "dosyada var" : "");
      setFfTokOk(credFound.ff_token ? true : null);
      return;
    }
    const id = setTimeout(async () => {
      const { d } = await jpost<{ valid: boolean | null; message: string; expiring_soon?: boolean }>(
        "/api/check-token",
        { value: t },
      );
      setFfTokOk(d.expiring_soon ? false : d.valid);
      setFfTokMsg(d.message);
    }, 400);
    return () => clearTimeout(id);
  }, [creds.ff_token, credFound.ff_token]);

  function startPolling(name: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const d = await jget<Record<string, unknown>>(`/api/progress/${encodeURIComponent(name)}`);
        setProgress(d);
        if (Array.isArray(d.expiring_soon) && d.expiring_soon.length) {
          setExpiryWarnings(
            d.expiring_soon as { label: string; message: string }[],
          );
        }
        void loadOutputs(name);
        const phase = d.phase as string | null;
        const alive = d.alive !== false;
        if (!phase || ["bitti", "hata", "durduruldu"].includes(phase)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setCurrent(null);
          setLiveOn(false);
          setLiveTxt(phase || "tamam");
        } else if (!alive) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setCurrent(null);
          setLiveOn(false);
          setLiveTxt("hata");
        } else {
          setLiveOn(true);
          setLiveTxt(phase);
        }
      } catch {
        /* */
      }
    };
    tick();
    pollRef.current = setInterval(tick, 4000);
  }

  async function saveProjectIdFile() {
    const v = creds.project?.trim();
    if (!v) {
      setProjectSaveMsg("Proje ID boş");
      return;
    }
    const { ok, d } = await jpost<{ detail?: string; value?: string }>("/api/save-project", {
      value: v,
      project: project || undefined,
    });
    if (!ok) {
      setProjectSaveMsg((d as { detail?: string }).detail || "kaydedilemedi");
      return;
    }
    setProjectSaveMsg(`✓ hailuo_project.txt → ${(d as { value?: string }).value}`);
    await loadCredentials(project || undefined);
  }

  async function saveCookieFile() {
    setCookieSaveMsg("");
    const { ok, d } = await jpost<{ detail?: string; length?: number }>("/api/save-cookie", {
      value: cookiePaste,
    });
    if (!ok) {
      setCookieSaveMsg((d as { detail?: string }).detail || "kaydedilemedi");
      return;
    }
    setCookiePaste("");
    setCookieSaveMsg(`✓ hailuo_cookie.txt kaydedildi (${(d as { length?: number }).length} karakter)`);
    await loadCredentials(project || undefined);
  }

  async function saveFireflyTokenFile() {
    setFfTokenSaveMsg("");
    const v = creds.ff_token?.trim();
    if (!v) {
      setFfTokenSaveMsg("Curl / token boş");
      return;
    }
    const { ok, d } = await jpost<{
      detail?: string;
      length?: number;
      saved?: string[];
      arp_saved?: boolean;
      nonce_saved?: boolean;
    }>("/api/save-firefly-token", {
      value: v,
    });
    if (!ok) {
      setFfTokenSaveMsg((d as { detail?: string }).detail || "kaydedilemedi");
      return;
    }
    setFfTokenSaveMsg(
      (d as { detail?: string }).detail ||
        `✓ kaydedildi (${(d as { length?: number }).length} karakter)`,
    );
    await loadCredentials(project || undefined);
  }

  async function doStart(opts?: { scenes?: string | null; regeneratePrompts?: boolean }) {
    setConfirmOpen(false);
    setStartMsg("başlatılıyor…");
    const keys = await flushApiKeys();
    const regen = opts?.regeneratePrompts ?? regenPrompts;
    const body: Record<string, unknown> = {
      project,
      provider: "hailuo",
      variants: variantsParam,
      concurrency: effectiveConcurrency,
      credentials: creds,
      prompt_optimizer: optimizer,
      keyframes_source: keyframesSource,
      regenerate_prompts: regen,
      ...(Object.keys(keys).length ? { api_keys: keys } : {}),
    };
    if (opts?.scenes?.trim()) body.scenes = opts.scenes.trim();
    const { ok, status, d } = await jpost<{
      detail?: string;
      pid?: number;
      queue_note?: string | null;
      other_runs?: { project?: string; pid?: number }[];
    }>("/api/start", body);
    if (!ok) {
      const detail = (d as { detail?: string }).detail;
      setStartMsg(`${status}: ${detail || "hata"}`);
      return;
    }
    const queue = (d as { queue_note?: string | null }).queue_note;
    const others = (d as { other_runs?: { project?: string }[] }).other_runs;
    const parallelNote =
      others && others.length
        ? ` · paralel ${others.length} başka koşu${queue ? ` (${queue})` : ""}`
        : "";
    setStartMsg(`başladı (pid ${d.pid})${parallelNote}`);
    setCurrent(project);
    startPolling(project);
  }

  async function retryFailed() {
    if (!project) return;
    setStartMsg("hatalılar temizleniyor…");
    const { ok, status, d } = await jpost<{
      detail?: string;
      cleared?: number;
      scenes?: number[];
      scenes_param?: string;
    }>(`/api/project/${encodeURIComponent(project)}/retry-failed`, {});
    if (!ok) {
      setStartMsg(`${status}: ${(d as { detail?: string }).detail || "retry hazırlanamadı"}`);
      return;
    }
    const scenesParam = String(d.scenes_param || "").trim();
    if (!scenesParam) {
      setStartMsg(d.detail || "Yeniden denenecek hata yok");
      return;
    }
    setStartMsg(`hatalı ${d.cleared} kayıt temizlendi → sahneler ${scenesParam}`);
    // Video retry: mevcut promptlar + eksikler; Gemini baştan yok
    await doStart({ scenes: scenesParam, regeneratePrompts: false });
  }

  const scenarioLabel: Record<string, string> = {
    A: "A — scene_description",
    B: "B — Gemini (video)",
    "B-eksik": "B — eksik",
  };

  return (
    <div className="wrap">
      <StartConfirmModal
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doStart()}
        summary={{
          project,
          scenes: sceneCount ?? pmeta?.scene_count ?? null,
          keyframes: keyframesSource === "swapped" ? "Swapped" : "Orijinal",
          variants: variantsSummary,
          totalVideos,
          scenario: scenarioLabel[scenario || ""] || scenario || "—",
          concurrency: effectiveConcurrency,
          promptOptimizer: optimizer,
          regenPrompts,
        }}
      />
      <header className="top">
        <div className="brand">
          <h1>L2.5 Studio</h1>
          <span className="brand-badge">{project || "—"}</span>
        </div>
        <span className="divider" aria-hidden />
        <nav className="nav" aria-label="Bölümler">
          <span className="nav-pill on">Panel</span>
          <span className="nav-pill">Çıktılar</span>
        </nav>
        <span className="live">
          <span className="dot" style={{ background: liveOn ? "var(--ok)" : "var(--idle)" }} />
          {liveTxt}
        </span>
      </header>

      <div className="grid">
        <div className="card">
          <h2>Kur &amp; Başlat</h2>

          <div style={{ marginBottom: 14, paddingBottom: 13, borderBottom: "1px solid var(--border)" }}>
            <div className="section-t" style={{ margin: "0 0 8px" }}>
              Proje yükle{" "}
              <span style={{ textTransform: "none", fontWeight: 400, color: "var(--muted)" }}>
                — ad JSON/videodan
              </span>
            </div>

            <div className="section-t" style={{ margin: "0 0 6px" }}>Keyframe kaynağı</div>
            <div className="seg" role="group" aria-label="Keyframe kaynağı">
              <button
                type="button"
                className={`seg-btn${uploadSource === "original" ? " on" : ""}`}
                onClick={() => setUploadSource("original")}
              >
                Orijinal
                <small>keyframes/</small>
              </button>
              <button
                type="button"
                className={`seg-btn${uploadSource === "swapped" ? " on swapped" : ""}`}
                onClick={() => setUploadSource("swapped")}
              >
                Swapped
                <small>keyframes_swapped/</small>
              </button>
            </div>

            {derivedProject ? (
              <div className="derived">Proje: <b>{derivedProject}</b></div>
            ) : null}

            <FileDrop
              label="1. Scenes JSON"
              hint="Scenes JSON"
              file={dropScenes}
              accept=".json,application/json"
              onFile={setDropScenes}
            />
            <FileDrop
              label={`2. Keyframes ZIP (${uploadSource === "swapped" ? "swapped" : "orijinal"})`}
              hint="Keyframes ZIP"
              file={dropZip}
              accept=".zip,application/zip"
              onFile={setDropZip}
            />
            <FileDrop
              label="3. Kaynak video (opsiyonel)"
              hint="Kaynak video"
              file={dropVideo}
              accept=".mp4,.mov,.webm,video/*"
              onFile={setDropVideo}
            />

            <button
              className="primary"
              style={{ marginTop: 10 }}
              disabled={uploading || !derivedProject || !dropScenes || !dropZip}
              onClick={() => void doUpload()}
            >
              {uploading ? "Yükleniyor…" : "Yükle"}
            </button>
            {uploadMsg && <div className="hint" style={{ marginTop: 6 }}>{uploadMsg}</div>}
          </div>

          <div style={{ marginBottom: 14, paddingBottom: 13, borderBottom: "1px solid var(--border)" }}>
            <div className="section-t" style={{ margin: "0 0 8px" }}>API Anahtarları</div>
            <CollapsibleFld
              id="gemini"
              title="GEMINI_API_KEY"
              open={!!openFields.gemini}
              onToggle={toggleField}
              badge={
                <span className={`badge ${envSet.GEMINI_API_KEY ? "b-ok" : "b-warn"}`}>
                  {envSet.GEMINI_API_KEY ? "✓ var" : "✗ yok"}
                </span>
              }
            >
              <input
                ref={geminiInputRef}
                type="password"
                placeholder={envSet.GEMINI_API_KEY ? "kaydedildi — değiştirmek için yeni key yapıştır" : "API key yapıştır"}
                value={apiKeys.GEMINI_API_KEY}
                onChange={(e) => void onKey("GEMINI_API_KEY", e.target.value)}
              />
              {geminiSavedMask && !apiKeys.GEMINI_API_KEY && (
                <div className="mono-sm" style={{ marginTop: 6 }}>{geminiSavedMask}</div>
              )}
              <button
                type="button"
                className="ghost"
                style={{ marginTop: 6 }}
                disabled={!apiKeys.GEMINI_API_KEY.trim()}
                onClick={() => void saveGeminiKeyFile()}
              >
                gemini_api_key.txt olarak kaydet
              </button>
              {geminiSaveMsg && <div className="hint" style={{ marginTop: 4 }}>{geminiSaveMsg}</div>}
            </CollapsibleFld>
            <CollapsibleFld
              id="anthropic"
              title="ANTHROPIC_API_KEY"
              open={!!openFields.anthropic}
              onToggle={toggleField}
              optional
              optionalOn={useAnthropic}
              onOptionalChange={setUseAnthropic}
              optionalLabel="S4 yumuşatma"
              badge={
                useAnthropic ? (
                  <span className={`badge ${envSet.ANTHROPIC_API_KEY ? "b-ok" : "b-warn"}`}>
                    {envSet.ANTHROPIC_API_KEY ? "✓ var" : "✗ yok"}
                  </span>
                ) : (
                  <span className="badge b-idle">kapalı</span>
                )
              }
            >
              <input
                ref={anthropicInputRef}
                type="password"
                placeholder=""
                disabled={!useAnthropic}
                value={apiKeys.ANTHROPIC_API_KEY}
                onChange={(e) => void onKey("ANTHROPIC_API_KEY", e.target.value)}
              />
            </CollapsibleFld>
          </div>

          <CollapsibleFld
            id="cred-ff_token"
            title={`Firefly Curl${needsFirefly ? " *" : ""}`}
            open={openFields["cred-ff_token"] !== false}
            onToggle={toggleField}
            badge={
              ffTokMsg ? (
                <span className={`badge ${ffTokOk === true ? "b-ok" : ffTokOk === false ? "b-err" : "b-warn"}`}>
                  {ffTokMsg}
                </span>
              ) : creds.ff_token?.trim() || credFound.ff_token ? (
                <span className="badge b-ok">✓</span>
              ) : (
                <span className={`badge ${needsFirefly ? "b-err" : "b-warn"}`}>
                  {needsFirefly ? "gerekli" : "boş"}
                </span>
              )
            }
          >
            <textarea
              rows={5}
              value={creds.ff_token || ""}
              onChange={(e) => setCreds((c) => ({ ...c, ff_token: e.target.value }))}
              placeholder="F12 → Network → generate-async veya ingest → Copy as cURL (Windows curl.exe OK)"
              spellCheck={false}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
            />
            <div className="hint" style={{ marginTop: 4 }}>
              Bearer + x-arp-session-id + x-nonce (+ UA) ayıklanır → firefly/kling/runway dosyalarına yazılır
            </div>
            {creds.ff_token?.trim() && !/curl|authorization\s*:/i.test(creds.ff_token) && (
              <div className="mono-sm" style={{ marginTop: 6 }}>{mask(creds.ff_token)}</div>
            )}
            {creds.ff_token?.trim() && /curl|authorization\s*:/i.test(creds.ff_token) && (
              <div className="mono-sm" style={{ marginTop: 6 }}>
                cURL yapıştırıldı ({creds.ff_token.length} karakter)
              </div>
            )}
            <button
              type="button"
              className="ghost"
              style={{ marginTop: 6 }}
              disabled={!creds.ff_token?.trim()}
              onClick={() => void saveFireflyTokenFile()}
            >
              Curl&apos;den ayıkla ve kaydet
            </button>
            {ffTokenSaveMsg && <div className="hint" style={{ marginTop: 4 }}>{ffTokenSaveMsg}</div>}
          </CollapsibleFld>

          {needsHailuo &&
            hailuoModel?.credentials
              .filter((cr) => !cr.autoFromFile)
              .map((cr) => (
            <CollapsibleFld
              key={cr.key}
              id={`cred-${cr.key}`}
              title={`${cr.label}${cr.required ? " *" : ""}`}
              open={!!openFields[`cred-${cr.key}`]}
              onToggle={toggleField}
              badge={
                cr.key === "token" && tokMsg ? (
                  <span className={`badge ${tokOk === true ? "b-ok" : tokOk === false ? "b-err" : "b-warn"}`}>
                    {tokMsg}
                  </span>
                ) : creds[cr.key]?.trim() ? (
                  <span className="badge b-ok">✓</span>
                ) : (
                  <span className="badge b-warn">boş</span>
                )
              }
            >
              <input
                type={cr.secret ? "password" : "text"}
                value={creds[cr.key] || ""}
                onChange={(e) => setCreds((c) => ({ ...c, [cr.key]: e.target.value }))}
              />
              {cr.key === "token" && creds[cr.key] && (
                <div className="mono-sm" style={{ marginTop: 6 }}>{mask(creds[cr.key])}</div>
              )}
              {cr.key === "project" && (
                <>
                  <button
                    type="button"
                    className="ghost"
                    style={{ marginTop: 6 }}
                    disabled={!creds.project?.trim()}
                    onClick={() => void saveProjectIdFile()}
                  >
                    hailuo_project.txt olarak kaydet
                  </button>
                  {projectSaveMsg && <div className="hint" style={{ marginTop: 4 }}>{projectSaveMsg}</div>}
                </>
              )}
            </CollapsibleFld>
          ))}
          {needsHailuo && hailuoModel?.credentials.some((cr) => cr.autoFromFile && cr.key === "cookie") && (
            <CollapsibleFld
              id="cookie"
              title="Cookie"
              open={!!openFields.cookie}
              onToggle={toggleField}
              badge={
                <span
                  className={`badge ${
                    !cookieOk
                      ? "b-err"
                      : cookieValid === false
                        ? "b-err"
                        : cookieValid === true
                          ? "b-ok"
                          : "b-warn"
                  }`}
                >
                  {!cookieOk ? "✗ yok" : cookieMsg || "—"}
                </span>
              }
            >
              <textarea
                rows={3}
                placeholder=""
                value={cookiePaste}
                onChange={(e) => setCookiePaste(e.target.value)}
                style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              />
              <button
                type="button"
                className="ghost"
                style={{ marginTop: 6 }}
                disabled={!cookiePaste.trim()}
                onClick={() => void saveCookieFile()}
              >
                hailuo_cookie.txt olarak kaydet
              </button>
              {cookieSaveMsg && <div className="hint" style={{ marginTop: 4 }}>{cookieSaveMsg}</div>}
            </CollapsibleFld>
          )}

          {needsHailuo && (
            <CollapsibleFld
              id="prompt-optimizer"
              title="Hailuo Prompt Optimizer"
              open={openFields["prompt-optimizer"] !== false}
              onToggle={toggleField}
              badge={
                <span className={`badge ${optimizer ? "b-ok" : "b-warn"}`}>
                  {optimizer ? "açık" : "kapalı"}
                </span>
              }
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={optimizer}
                  onChange={(e) => setOptimizer(e.target.checked)}
                />
                Hailuo promptu kendi optimize etsin
              </label>
            </CollapsibleFld>
          )}

          <CollapsibleFld
            id="regen-prompts"
            title="Gemini promptlar"
            open={openFields["regen-prompts"] !== false}
            onToggle={toggleField}
            badge={
              <span className={`badge ${regenPrompts ? "b-warn" : "b-ok"}`}>
                {regenPrompts ? "baştan" : pmeta?.has_prompts ? "mevcut+eksik" : "üret"}
              </span>
            }
          >
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={regenPrompts}
                onChange={(e) => setRegenPrompts(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Promptları baştan yeniden üret
                <div className="mono-sm" style={{ marginTop: 4, opacity: 0.75 }}>
                  Kapalı (varsayılan): hazır promptlar kalır, yalnız eksikler Gemini’den gelir; hepsi
                  hazırsa faz atlanır. Açık: seçili aralıktaki promptlar silinip yeniden yazılır.
                </div>
              </span>
            </label>
          </CollapsibleFld>

          <CollapsibleFld
              id="variants"
              title="Varyantlar"
              open={openFields.variants !== false}
              onToggle={toggleField}
              badge={
                <span className={`badge ${selectedVariants.length ? "b-ok" : "b-warn"}`}>
                  {selectedVariants.length ? selectedVariants.join(",") : "—"}
                </span>
              }
            >
              {VARIANT_KEYS.map((k) => (
                <label
                  key={k}
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 6 }}
                >
                  <input
                    type="checkbox"
                    checked={variantSel[k]}
                    onChange={(e) => setVariantSel((v) => ({ ...v, [k]: e.target.checked }))}
                  />
                  {VARIANT_LABELS[k]}
                </label>
              ))}
              <div className="seg" role="group" aria-label="Varyant önayarları" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className={`seg-btn${selectedVariants.length === 4 ? " on" : ""}`}
                  onClick={() => setVariantSel({ v1: true, v2: true, v3: true, v4: true })}
                >
                  Tümü
                  <small>v1+v2+v3+v4</small>
                </button>
                {VARIANT_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`seg-btn${selectedVariants.length === 1 && variantSel[k] ? " on" : ""}`}
                    onClick={() =>
                      setVariantSel({ v1: k === "v1", v2: k === "v2", v3: k === "v3", v4: k === "v4" })
                    }
                  >
                    Yalnız {k}
                  </button>
                ))}
              </div>
            </CollapsibleFld>

          <label className="fld">
            <span>Üretilecek Proje</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">— seç —</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.scene_count ?? "?"} sahne)
                </option>
              ))}
            </select>
            {pmeta && (
              <div className="proj-badges">
                <span className={`badge ${pmeta.has_keyframes ? "b-ok" : "b-err"}`}>
                  keyframes {pmeta.has_keyframes ? "✓" : "✗"}
                </span>
                <span className={`badge ${pmeta.has_keyframes_swapped ? "b-ok" : "b-idle"}`}>
                  swapped {pmeta.has_keyframes_swapped ? "✓" : "—"}
                </span>
                <span className={`badge ${scenario === "A" ? "b-ok" : "b-warn"}`}>
                  desc {scenario === "A" ? "✓" : "?"}
                </span>
              </div>
            )}
            {project && (
              <>
                <div className="section-t" style={{ margin: "12px 0 6px" }}>Koşuda kullanılacak</div>
                <div className="seg" role="group" aria-label="Koşu keyframe kaynağı">
                  <button
                    type="button"
                    className={`seg-btn${keyframesSource === "original" ? " on" : ""}`}
                    onClick={() => setKeyframesSource("original")}
                  >
                    Orijinal
                    <small>{pmeta?.has_keyframes ? "hazır" : "yok"}</small>
                  </button>
                  <button
                    type="button"
                    className={`seg-btn${keyframesSource === "swapped" ? " on swapped" : ""}`}
                    onClick={() => setKeyframesSource("swapped")}
                  >
                    Swapped
                    <small>{pmeta?.has_keyframes_swapped ? "hazır" : "yok"}</small>
                  </button>
                </div>
              </>
            )}
            {preflightTxt && <div className="hint">{preflightTxt}</div>}
          </label>

          <label className="fld">
            <span>Eşzamanlılık{hybridRun ? " (Hailuo)" : fireflyOnly ? " (Firefly sıralı)" : ""}</span>
            <input
              type="number"
              min={1}
              max={6}
              value={effectiveConcurrency}
              disabled={fireflyOnly}
              onChange={(e) => setConcurrency(Number(e.target.value) || 2)}
            />
          </label>

          <button
            className="primary"
            disabled={missing.length > 0 || !!current}
            onClick={() => setConfirmOpen(true)}
          >
            Başlat
          </button>
          <div className="hint" style={{ marginTop: 8 }}>
            {current ? "koşu sürüyor…" : missing.length ? `Eksik: ${missing.join(" · ")}` : startMsg}
          </div>
        </div>

        <div className="card">
          <h2>Canlı İlerleme</h2>
          {!progress ? (
            <div className="empty">Bir koşu başlatın — ilerleme burada görünür.</div>
          ) : (
            <ProgressView
              d={progress}
              onStop={async () => {
                await jpost("/api/stop", { project });
                if (pollRef.current) clearInterval(pollRef.current);
                setCurrent(null);
                setLiveOn(false);
                setLiveTxt("durduruldu");
              }}
              onOpen={async () => {
                const prov = String(progress.provider || (fireflyOnly ? "firefly" : "hailuo"));
                await jpost("/api/open", { project: progress.project, target: "videos", provider: prov });
              }}
              onRetryFailed={() => void retryFailed()}
            />
          )}
        </div>

        <div className="card">
          <div className="out-head">
            <h2 style={{ margin: 0 }}>Çıktılar</h2>
            <div className="out-actions">
              <button
                type="button"
                className="ghost sm"
                disabled={!project || outputsLoading}
                onClick={() => void loadOutputs(undefined, fireflyOnly ? "firefly" : "hailuo")}
              >
                {outputsLoading ? "…" : "Yenile"}
              </button>
              {outputs.length > 0 && project && needsHailuo && (
                <a
                  className="ghost sm link-btn"
                  href={`/api/project/${encodeURIComponent(project)}/download?zip=1&provider=hailuo`}
                  download
                >
                  Hailuo ZIP
                </a>
              )}
              {outputs.length > 0 && project && needsFirefly && (
                <a
                  className="ghost sm link-btn"
                  href={`/api/project/${encodeURIComponent(project)}/download?zip=1&provider=firefly`}
                  download
                >
                  Firefly ZIP
                </a>
              )}
            </div>
          </div>
          {!project ? (
            <div className="empty">Proje seçin — hazır videolar burada listelenir.</div>
          ) : outputs.length === 0 ? (
            <div className="empty">
              {outputsLoading ? "Yükleniyor…" : "Henüz hazır video yok — üretim bitince otomatik kaydedilir."}
            </div>
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                {outputs.length} video · otomatik kayıt: <span className="mono-sm">{outputFolder}</span>
                {Object.keys(failByFile).length > 0 && (
                  <> · <span className="badge b-warn">{Object.keys(failByFile).length} kötü işaretli</span></>
                )}
              </div>
              <div className="fail-box">
                <div className="section-t" style={{ marginTop: 0 }}>Kötü çıktı → Gemini kural defteri</div>
                <div className="hint" style={{ marginBottom: 8 }}>
                  Bozuk videoyu seç + neden + not → <b>Analiz et</b>. Gemini anladığını popup’ta gösterir;
                  onaylarsan kural defterine yazar (yalnız prompt yazarken kullanır — Hailuo/Firefly metnine eklenmez).
                  {(learnedCount.must > 0 || learnedCount.soft > 0) && (
                    <>
                      {" "}
                      Defter: <span className="badge b-ok">{learnedCount.must} kesin</span>{" "}
                      <span className="badge b-warn">{learnedCount.soft} dikkat</span>
                    </>
                  )}
                </div>
                <div className="fail-tags">
                  {(failTagMeta.length
                    ? failTagMeta
                    : [
                        { key: "morph", label: "Morph" },
                        { key: "end_miss", label: "End pose kaçtı" },
                        { key: "frozen", label: "Donuk" },
                        { key: "identity", label: "Kimlik" },
                        { key: "physics_flat", label: "Fizik yok" },
                        { key: "camera_fight", label: "Kamera" },
                        { key: "too_much_action", label: "Fazla aksiyon" },
                        { key: "story_break", label: "Olay/bağlam kopukluğu" },
                      ]
                  ).map((t) => (
                    <label key={t.key} className={`fail-tag${failPickTags[t.key] ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={Boolean(failPickTags[t.key])}
                        onChange={(e) =>
                          setFailPickTags((prev) => ({ ...prev, [t.key]: e.target.checked }))
                        }
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder=""
                  value={failNote}
                  onChange={(e) => setFailNote(e.target.value)}
                  style={{ marginTop: 8, marginBottom: 8 }}
                />
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={failBusy || !failSelectedNames.length || !failPickTagKeys.length}
                    onClick={() => void analyzeFailForRules()}
                    style={{ color: "var(--accent-ink)", borderColor: "var(--accent)" }}
                  >
                    {failBusy && !ruleModal ? "Analiz…" : "Analiz et (Gemini)"}
                  </button>
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={failBusy || !failSelectedNames.length || !failPickTagKeys.length}
                    onClick={() => void saveFailLessons()}
                  >
                    Sadece işaretle
                  </button>
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={failBusy || !failSelectedNames.length}
                    onClick={() => void clearFailLessons()}
                  >
                    İşareti kaldır
                  </button>
                </div>
                {failMsg && <div className="hint" style={{ marginTop: 6 }}>{failMsg}</div>}
              </div>
              <ul className="out-list">
                {outputs.map((f) => {
                  const marked = failByFile[f.name];
                  return (
                    <li key={f.name} className={`out-row${failSelected[f.name] ? " sel" : ""}${marked ? " bad" : ""}`}>
                      <label className="out-check">
                        <input
                          type="checkbox"
                          checked={Boolean(failSelected[f.name])}
                          onChange={(e) =>
                            setFailSelected((prev) => ({ ...prev, [f.name]: e.target.checked }))
                          }
                        />
                      </label>
                      <div className="out-meta">
                        <span className="out-name">{f.name}</span>
                        <span className="mono-sm out-sub">
                          {[f.scene, f.variant, f.size_label].filter(Boolean).join(" · ")}
                          {marked?.tags?.length ? ` · ${marked.tags.join(", ")}` : ""}
                        </span>
                      </div>
                      <a className="ghost sm dl-btn" href={f.download_url} download={f.name}>
                        İndir
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      {ruleModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Gemini ne anladı?</h3>
            <div className="hint" style={{ marginBottom: 8 }}>
              Kurallar deftere yazılmadan önce onayla. Beğenmezsen aşağıya daha detay yazıp yeniden analiz ettir.
            </div>
            <div className="modal-block">
              <div className="section-t" style={{ marginTop: 0 }}>Anladığı</div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45 }}>{ruleModal.understanding}</p>
            </div>
            <div className="modal-block">
              <div className="section-t" style={{ marginTop: 0 }}>Önerilen kural</div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45, fontFamily: "var(--mono)" }}>
                {ruleModal.proposed_rule}
              </p>
            </div>
            <label className="fld" style={{ marginBottom: 10 }}>
              <span>Beğenmedim — daha detaylı anlat</span>
              <input
                type="text"
                value={ruleRefine}
                onChange={(e) => setRuleRefine(e.target.value)}
                placeholder=""
              />
            </label>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button
                type="button"
                className="ghost sm"
                disabled={failBusy || !ruleRefine.trim()}
                onClick={() => void refineRuleAnalysis()}
              >
                {failBusy ? "…" : "Yeniden analiz"}
              </button>
              <button
                type="button"
                className="ghost sm"
                disabled={failBusy}
                onClick={() => setRuleModal(null)}
              >
                İptal
              </button>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="ghost sm"
                disabled={failBusy}
                onClick={() => void approveLearnedRule("must")}
                style={{ color: "var(--err)", borderColor: "var(--err)", fontWeight: 700 }}
              >
                Kesin yargı olarak ekle
              </button>
              <button
                type="button"
                className="ghost sm"
                disabled={failBusy}
                onClick={() => void approveLearnedRule("soft")}
                style={{ color: "var(--warn)", borderColor: "var(--warn)", fontWeight: 650 }}
              >
                Dikkat edilsin olarak ekle
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressView({
  d,
  onStop,
  onOpen,
  onRetryFailed,
}: {
  d: Record<string, unknown>;
  onStop: () => void;
  onOpen: () => void;
  onRetryFailed?: () => void;
}) {
  const phase = d.phase as string | null;
  const phaseMap: Record<string, [string, string]> = {
    prompt_uretiliyor: ["Prompt üretiliyor", "p-prompt pulse"],
    video_uretiliyor: ["Video üretiliyor", "p-video pulse"],
    basliyor: ["Başlıyor", "p-video pulse"],
    bitti: ["Bitti", "p-done"],
    hata: ["Hata", "p-err"],
    durduruldu: ["Durduruldu", "p-err"],
  };
  const [ptxt, pcls] = phaseMap[phase || ""] || ["Boşta", "p-idle"];
  const c = (d.counts || {}) as Record<string, number>;
  const producing = (d.producing || []) as { id: string; label: string }[];
  const errors = (d.errors || []) as { id: string; scene: string; error: string }[];
  const warnings = (d.warnings || []) as string[];
  const runError = d.error ? String(d.error) : null;
  const logTail = (d.log_tail || []) as string[];
  const pm = (d.progress_meta || {}) as {
    prompt?: { current?: number; total?: number; percent?: number };
    video?: { current?: number; total?: number; percent?: number };
  };
  const activeProg = phase === "prompt_uretiliyor" ? pm.prompt : pm.video;
  const progCurrent = Number(activeProg?.current || 0);
  const progTotal = Number(activeProg?.total || 0);
  const progPercent = Math.max(0, Math.min(100, Number(activeProg?.percent || 0)));
  const canRetry = Boolean(onRetryFailed) && errors.length > 0 && !d.alive;

  return (
    <div>
      <div className="phase">
        <span className={`pill ${pcls}`}>{ptxt}</span>
        <span className="mono-sm">{String(d.project)}</span>
      </div>
      {runError && phase === "hata" && (
        <div className="warns" style={{ marginBottom: 12, borderColor: "var(--err)", color: "var(--err)" }}>
          {runError}
        </div>
      )}
      {progTotal > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="mono-sm" style={{ marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
            <span>{progCurrent}/{progTotal}</span>
            <span>%{progPercent}</span>
          </div>
          <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 999, overflow: "hidden" }}>
            <div
              style={{
                width: `${progPercent}%`,
                height: "100%",
                background: "var(--accent)",
                transition: "width 250ms ease",
              }}
            />
          </div>
        </div>
      )}
      {phase === "prompt_uretiliyor" ? (
        <div className="waiting">⏳ Prompt üretiliyor (Gemini)…</div>
      ) : (
        <>
          <div className="stats">
            <div className="stat done"><div className="k">Tamamlanan</div><div className="n">{c.done || 0}</div></div>
            <div className="stat prod"><div className="k">Üretiliyor</div><div className="n">{c.submitted || 0}</div></div>
            <div className="stat err"><div className="k">Hata</div><div className="n">{c.error || 0}</div></div>
            <div className="stat"><div className="k">Softened</div><div className="n">{((d.softened as unknown[]) || []).length}</div></div>
          </div>
          {producing.length > 0 && (
            <>
              <div className="section-t">Şu an üretilen</div>
              <ul className="list">{producing.map((p) => <li key={p.id}><span className="chip c-soft">•</span> {p.label}</li>)}</ul>
            </>
          )}
          {errors.length > 0 && (
            <>
              <div className="section-t" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span>Hatalar</span>
                {canRetry && (
                  <button
                    type="button"
                    className="ghost sm"
                    style={{ color: "var(--accent-ink)", borderColor: "var(--accent)" }}
                    onClick={onRetryFailed}
                  >
                    Hatalıları tekrar dene
                  </button>
                )}
              </div>
              <ul className="list">
                {errors.map((e) => (
                  <li key={e.id}><span className="chip c-err">hata</span> <div><b>{e.scene}</b><div className="mono-sm">{e.error}</div></div></li>
                ))}
              </ul>
            </>
          )}
          <div className="section-t">Uyarılar</div>
          {warnings.length ? (
            <div className="warns">{warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
          ) : (
            <div className="empty">uyarı yok</div>
          )}
          {logTail.length > 0 && phase === "hata" && (
            <>
              <div className="section-t">Log (son satırlar)</div>
              <div className="warns">{logTail.map((line, i) => <div key={i}>{line}</div>)}</div>
            </>
          )}
        </>
      )}
      <div className="actions">
        <button className="ghost" disabled={!d.alive} onClick={onStop}>Durdur</button>
        {canRetry && (
          <button
            type="button"
            className="ghost"
            style={{ color: "var(--accent-ink)", borderColor: "var(--accent)" }}
            onClick={onRetryFailed}
          >
            Hatalıları tekrar dene
          </button>
        )}
        <button className="ghost" style={{ color: "var(--accent-ink)", borderColor: "var(--accent)" }} onClick={onOpen}>
          Klasörü Aç
        </button>
      </div>
    </div>
  );
}
