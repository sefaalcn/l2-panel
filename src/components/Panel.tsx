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

export default function Panel() {
  const [models, setModels] = useState<Record<string, ModelDef>>({});
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [modelKey, setModelKey] = useState("hailuo");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [optimizer, setOptimizer] = useState(true);
  const [concurrency, setConcurrency] = useState(2);
  const [variantsSummary, setVariantsSummary] = useState("");
  const [totalVideos, setTotalVideos] = useState<number | null>(null);
  const [scenario, setScenario] = useState<string | null>(null);
  const [needsGemini, setNeedsGemini] = useState(false);
  const [needsFirefly, setNeedsFirefly] = useState(false);
  const [fireflyModels, setFireflyModels] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<
    { name: string; size_label: string; scene: string | null; variant: string | null; download_url: string }[]
  >([]);
  const [outputFolder, setOutputFolder] = useState("hailuo_router_videos/");
  const [outputsLoading, setOutputsLoading] = useState(false);
  const [preflightTxt, setPreflightTxt] = useState("");
  const [tokMsg, setTokMsg] = useState("");
  const [tokOk, setTokOk] = useState<boolean | null>(null);
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
  const [openFields, setOpenFields] = useState<Record<string, boolean>>({});
  const [useAnthropic, setUseAnthropic] = useState(false);
  const [apiKeys, setApiKeys] = useState({ GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sceneCount, setSceneCount] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const geminiInputRef = useRef<HTMLInputElement>(null);
  const anthropicInputRef = useRef<HTMLInputElement>(null);

  const toggleField = useCallback((id: string) => {
    setOpenFields((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const model = models[modelKey];

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
  }, [mergeCreds]);

  const loadProjects = useCallback(async () => {
    const d = await jget<{ projects: Project[] }>("/api/projects");
    setProjects(d.projects || []);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await jget<{ models: Record<string, ModelDef>; env_set: Record<string, boolean> }>("/api/models");
      setModels(m.models);
      setEnvSet(m.env_set || {});
      setUseAnthropic(Boolean(m.env_set?.ANTHROPIC_API_KEY));
      const first = Object.keys(m.models).find((k) => m.models[k].active) || Object.keys(m.models)[0];
      setModelKey(first);
      const opt = m.models[first]?.options?.find((o) => o.key === "prompt_optimizer");
      setOptimizer(opt?.default !== false);
      await loadProjects();
      await loadCredentials();
    })().catch(console.error);
  }, [loadProjects, loadCredentials]);

  const loadOutputs = useCallback(async (projectName?: string, provider?: string) => {
    const p = projectName || project;
    if (!p) {
      setOutputs([]);
      return;
    }
    const prov = provider || modelKey;
    setOutputsLoading(true);
    try {
      const d = await jget<{
        files: { name: string; size_label: string; scene: string | null; variant: string | null; download_url: string }[];
        dir: string | null;
        output_folder?: string;
      }>(`/api/project/${encodeURIComponent(p)}/outputs?provider=${encodeURIComponent(prov)}`);
      setOutputs(d.files || []);
      if (d.output_folder) setOutputFolder(d.output_folder);
    } catch {
      setOutputs([]);
    } finally {
      setOutputsLoading(false);
    }
  }, [project, modelKey]);

  useEffect(() => {
    void loadOutputs(project || undefined, modelKey);
  }, [project, modelKey, loadOutputs]);

  useEffect(() => {
    if (project) void loadCredentials(project);
  }, [project, loadCredentials]);

  useEffect(() => {
    if (!project) {
      setScenario(null);
      setPreflightTxt("");
      setVariantsSummary("");
      setTotalVideos(null);
      setSceneCount(null);
      return;
    }
    const p = projects.find((x) => x.name === project);
    if (p?.keyframes_source) setKeyframesSource(p.keyframes_source);
    jget<{
      scenario: string;
      scene_count: number;
      warnings: string[];
      keyframes_source?: KeyframesSource;
      variants_summary?: string;
      total_videos?: number;
      needs_gemini?: boolean;
      has_firefly_scenes?: boolean;
      firefly_models?: string[];
    }>(`/api/project/${encodeURIComponent(project)}/preflight`)
      .then((d) => {
        setScenario(d.scenario);
        setNeedsGemini(Boolean(d.needs_gemini));
        setNeedsFirefly(Boolean(d.has_firefly_scenes));
        setFireflyModels(d.firefly_models || []);
        if (d.keyframes_source) setKeyframesSource(d.keyframes_source);
        setVariantsSummary(d.variants_summary || "");
        setTotalVideos(d.total_videos ?? null);
        setSceneCount(d.scene_count ?? null);
        const providerLbl = modelKey === "firefly" ? "Firefly" : "Hailuo";
        const scLbl: Record<string, string> = {
          A: `Senaryo A (scene_description → ${providerLbl})`,
          B: "Senaryo B (Gemini videodan üretecek)",
          "B-eksik": "Senaryo B — EKSİK (video yok)",
        };
        const w = d.warnings || [];
        const src = d.keyframes_source === "swapped" ? "swapped" : "original";
        setPreflightTxt(
          `${d.scene_count} sahne · ${scLbl[d.scenario] || ""} · kf=${src}` +
            (d.has_firefly_scenes
              ? ` · ${d.firefly_models?.length ? d.firefly_models.join(", ") : "Firefly"} sahneleri`
              : "") +
            (w.length ? ` · ⚠ ${w.length} uyarı` : "") +
            (p ? "" : ""),
        );
      })
      .catch(() => setScenario(null));
  }, [project, projects, modelKey]);

  const missing = useMemo(() => {
    const out: string[] = [];
    if (!model?.active) return ["bu model henüz aktif değil"];
    for (const cr of model.credentials) {
      if (cr.autoFromFile) {
        if (cr.required && !credFound[cr.key]) out.push(`${cr.label} (dosya)`);
        else if (cr.key === "cookie" && credFound.cookie && cookieValid === false) out.push("Cookie süresi dolmuş");
      } else if (cr.required && !creds[cr.key]?.trim()) {
        out.push(cr.label);
      }
    }
    if (!project) out.push("Üretilecek Proje seç");
    if (needsGemini && !envSet.GEMINI_API_KEY && !apiKeys.GEMINI_API_KEY.trim()) {
      out.push("GEMINI_API_KEY yok (alt/geek veya Senaryo B)");
    }
    if (
      modelKey === "hailuo" &&
      needsFirefly &&
      !creds.ff_token?.trim() &&
      !credFound.ff_token
    ) {
      out.push("Firefly Token (video_model sahneleri)");
    }
    if (scenario === "B-eksik") out.push("proje eksik: scene_description yok ve kaynak video yok");
    return out;
  }, [model, creds, credFound, cookieValid, project, scenario, needsGemini, needsFirefly, envSet, apiKeys, modelKey]);

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
        throw new Error(
          r.status
            ? `Sunucu yanıtı okunamadı (HTTP ${r.status}). Toplam ~${totalMb.toFixed(1)} MB — dosya çok büyük olabilir.`
            : "Sunucuya ulaşılamadı — panel http://localhost:3000 adresinde mi?",
        );
      }
      if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
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
    clearTimeout(keyTimers.current[k]);
    keyTimers.current[k] = setTimeout(async () => {
      const { d } = await jpost<Record<string, boolean>>("/api/keys", { [k]: v });
      setEnvSet(d);
    }, 400);
  }

  async function flushApiKeys() {
    const gemini = (geminiInputRef.current?.value ?? apiKeys.GEMINI_API_KEY).trim();
    const anthropic = (anthropicInputRef.current?.value ?? apiKeys.ANTHROPIC_API_KEY).trim();
    const payload: Record<string, string> = {
      GEMINI_API_KEY: gemini,
      ANTHROPIC_API_KEY: useAnthropic ? anthropic : "",
    };
    const { d } = await jpost<Record<string, boolean>>("/api/keys", payload);
    setEnvSet(d);
    return payload;
  }

  useEffect(() => {
    const tokenKey = modelKey === "firefly" ? "ff_token" : "token";
    const t = creds[tokenKey]?.trim();
    if (!t) {
      setTokMsg("");
      setTokOk(null);
      return;
    }
    const id = setTimeout(async () => {
      const { d } = await jpost<{ valid: boolean | null; message: string }>("/api/check-token", { value: t });
      setTokOk(d.valid);
      setTokMsg(d.message);
    }, 400);
    return () => clearTimeout(id);
  }, [creds.token, creds.ff_token, modelKey]);

  function startPolling(name: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const d = await jget<Record<string, unknown>>(`/api/progress/${encodeURIComponent(name)}`);
        setProgress(d);
        void loadOutputs(name, modelKey);
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

  async function doStart() {
    setConfirmOpen(false);
    setStartMsg("başlatılıyor…");
    const keys = await flushApiKeys();
    const { ok, status, d } = await jpost<{ detail?: string; pid?: number }>("/api/start", {
      project,
      provider: modelKey,
      variants: "v1,v2,v3",
      concurrency,
      credentials: creds,
      prompt_optimizer: optimizer,
      keyframes_source: keyframesSource,
      api_keys: keys,
    });
    if (!ok) {
      const detail = (d as { detail?: string }).detail;
      setStartMsg(`${status}: ${detail || "hata"}`);
      return;
    }
    setStartMsg(`başladı (pid ${d.pid})`);
    setCurrent(project);
    startPolling(project);
  }

  const pmeta = projects.find((p) => p.name === project);

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
          concurrency,
        }}
      />
      <header className="top">
        <h1>L2.5 Üretim Paneli</h1>
        <span className="sub">Next.js · ayrı alanlar: JSON · keyframes · video</span>
        <span style={{ marginLeft: "auto" }} className="sub">
          <span className="dot" style={{ background: liveOn ? "var(--ok)" : "var(--idle)" }} /> {liveTxt}
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
            ) : (
              <div className="hint" style={{ marginBottom: 8 }}>Proje adı JSON (veya ZIP/video) dosya adından alınır.</div>
            )}

            <FileDrop
              label="1. Scenes JSON"
              hint="*_scenes_manual.json"
              file={dropScenes}
              accept=".json,application/json"
              onFile={setDropScenes}
            />
            <FileDrop
              label={`2. Keyframes ZIP (${uploadSource === "swapped" ? "swapped" : "orijinal"})`}
              hint="*.zip — seçilen köke yazılır"
              file={dropZip}
              accept=".zip,application/zip"
              onFile={setDropZip}
            />
            <FileDrop
              label="3. Kaynak video (opsiyonel)"
              hint="prompt yoksa Gemini için .mp4 / .mov — ~200–300 MB desteklenir"
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
                placeholder="AIza…"
                value={apiKeys.GEMINI_API_KEY}
                onChange={(e) => void onKey("GEMINI_API_KEY", e.target.value)}
              />
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
                placeholder="sk-ant…"
                disabled={!useAnthropic}
                value={apiKeys.ANTHROPIC_API_KEY}
                onChange={(e) => void onKey("ANTHROPIC_API_KEY", e.target.value)}
              />
            </CollapsibleFld>
          </div>

          <label className="fld">
            <span>Model</span>
            <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
              {Object.entries(models).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            {model && !model.active && <div className="hint">Bu model henüz aktif değil.</div>}
          </label>

          {modelKey === "hailuo" && needsFirefly && (
            <CollapsibleFld
              id="cred-ff_token"
              title="Firefly Token (video_model sahneleri) *"
              open={!!openFields["cred-ff_token"]}
              onToggle={toggleField}
              badge={
                tokMsg && creds.ff_token ? (
                  <span className={`badge ${tokOk === true ? "b-ok" : tokOk === false ? "b-err" : "b-warn"}`}>
                    {tokMsg}
                  </span>
                ) : creds.ff_token?.trim() || credFound.ff_token ? (
                  <span className="badge b-ok">✓</span>
                ) : (
                  <span className="badge b-warn">boş</span>
                )
              }
            >
              <div className="hint" style={{ marginBottom: 8 }}>
                Bu projede {fireflyModels.length ? fireflyModels.join(", ") : "Firefly"} sahneleri var — Hailuo koşusunda otomatik Firefly&apos;a gider.
              </div>
              <input
                type="password"
                value={creds.ff_token || ""}
                onChange={(e) => setCreds((c) => ({ ...c, ff_token: e.target.value }))}
              />
            </CollapsibleFld>
          )}

          {model?.credentials.filter((cr) => !cr.autoFromFile).map((cr) => (
            <CollapsibleFld
              key={cr.key}
              id={`cred-${cr.key}`}
              title={`${cr.label}${cr.required ? " *" : ""}`}
              open={!!openFields[`cred-${cr.key}`]}
              onToggle={toggleField}
              badge={
                (cr.key === "token" || cr.key === "ff_token") && tokMsg ? (
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
              {(cr.key === "token" || cr.key === "ff_token") && creds[cr.key] && (
                <div className="mono-sm" style={{ marginTop: 6 }}>{mask(creds[cr.key])}</div>
              )}
              {cr.key === "ff_token" && (
                <div className="hint" style={{ marginTop: 6 }}>
                  F12 → Network → firefly.adobe.com isteği → Authorization: Bearer … (başlatınca firefly_token.txt olarak kaydedilir)
                </div>
              )}
            </CollapsibleFld>
          ))}
          {model?.credentials.some((cr) => cr.autoFromFile && cr.key === "cookie") && (
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
              {(!cookieOk || cookieValid === false) && (
                <>
                  <textarea
                    rows={3}
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
                </>
              )}
            </CollapsibleFld>
          )}

          {modelKey === "firefly" && model?.credentials.some((cr) => cr.autoFromFile && cr.key !== "cookie") && (
            <div className="hint" style={{ marginBottom: 10 }}>
              Opsiyonel dosyalar:{" "}
              {credFound.ff_arp ? "firefly_arp.txt ✓" : "firefly_arp.txt —"}
              {" · "}
              {credFound.ff_nonce ? "firefly_nonce.txt ✓" : "firefly_nonce.txt —"}
            </div>
          )}

          <div className="opts">
            {model?.options?.filter((o) => o.type === "toggle").map((op) => (
              <label key={op.key}>
                <input type="checkbox" checked={optimizer} onChange={(e) => setOptimizer(e.target.checked)} /> {op.label}
              </label>
            ))}
          </div>

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
            <span>Eşzamanlılık{modelKey === "firefly" ? " (Firefly sıralı)" : ""}</span>
            <input
              type="number"
              min={1}
              max={6}
              value={modelKey === "firefly" ? 1 : concurrency}
              disabled={modelKey === "firefly"}
              onChange={(e) => setConcurrency(Number(e.target.value) || 2)}
            />
            {modelKey === "firefly" && (
              <div className="hint">Adobe Firefly tek seferde bir video üretir — sıralı koşu.</div>
            )}
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
                await jpost("/api/stop", {});
                if (pollRef.current) clearInterval(pollRef.current);
                setCurrent(null);
                setLiveOn(false);
                setLiveTxt("durduruldu");
              }}
              onOpen={async () => {
                const prov = String(progress.provider || modelKey);
                await jpost("/api/open", { project: progress.project, target: "videos", provider: prov });
              }}
            />
          )}
        </div>

        <div className="card">
          <div className="out-head">
            <h2 style={{ margin: 0 }}>Çıktılar</h2>
            <div className="out-actions">
              <button type="button" className="ghost sm" disabled={!project || outputsLoading} onClick={() => void loadOutputs(undefined, modelKey)}>
                {outputsLoading ? "…" : "Yenile"}
              </button>
              {outputs.length > 0 && project && (
                <a
                  className="ghost sm link-btn"
                  href={`/api/project/${encodeURIComponent(project)}/download?zip=1&provider=${encodeURIComponent(modelKey)}`}
                  download
                >
                  ZIP indir
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
              </div>
              <ul className="out-list">
                {outputs.map((f) => (
                  <li key={f.name} className="out-row">
                    <div className="out-meta">
                      <span className="out-name">{f.name}</span>
                      <span className="mono-sm out-sub">
                        {[f.scene, f.variant, f.size_label].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <a className="ghost sm dl-btn" href={f.download_url} download={f.name}>
                      İndir
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressView({
  d,
  onStop,
  onOpen,
}: {
  d: Record<string, unknown>;
  onStop: () => void;
  onOpen: () => void;
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
  const producing = (d.producing || []) as string[];
  const errors = (d.errors || []) as { scene: string; error: string }[];
  const warnings = (d.warnings || []) as string[];
  const runError = d.error ? String(d.error) : null;
  const logTail = (d.log_tail || []) as string[];

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
      {phase === "prompt_uretiliyor" ? (
        <div className="waiting">⏳ Prompt üretiliyor (Gemini)…</div>
      ) : (
        <>
          <div className="stats">
            <div className="stat done"><div className="n">{c.done || 0}</div><div className="k">bitti</div></div>
            <div className="stat prod"><div className="n">{c.submitted || 0}</div><div className="k">üretiliyor</div></div>
            <div className="stat err"><div className="n">{c.error || 0}</div><div className="k">hata</div></div>
            <div className="stat"><div className="n">{((d.softened as unknown[]) || []).length}</div><div className="k">softened</div></div>
          </div>
          {producing.length > 0 && (
            <>
              <div className="section-t">Şu an üretilen</div>
              <ul className="list">{producing.map((s) => <li key={s}><span className="chip c-soft">•</span> {s}</li>)}</ul>
            </>
          )}
          {errors.length > 0 && (
            <>
              <div className="section-t">Hatalar</div>
              <ul className="list">
                {errors.map((e) => (
                  <li key={e.scene}><span className="chip c-err">hata</span> <div><b>{e.scene}</b><div className="mono-sm">{e.error}</div></div></li>
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
        <button className="ghost" style={{ color: "var(--accent-ink)", borderColor: "var(--accent)" }} onClick={onOpen}>
          Klasörü Aç
        </button>
      </div>
    </div>
  );
}
