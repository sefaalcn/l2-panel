"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ModelCred = { key: string; label: string; secret: boolean; required: boolean };
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

export default function Panel() {
  const [models, setModels] = useState<Record<string, ModelDef>>({});
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [modelKey, setModelKey] = useState("hailuo");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [optimizer, setOptimizer] = useState(true);
  const [concurrency, setConcurrency] = useState(2);
  const [scenes, setScenes] = useState("");
  const [scenario, setScenario] = useState<string | null>(null);
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const model = models[modelKey];

  const loadProjects = useCallback(async () => {
    const d = await jget<{ projects: Project[] }>("/api/projects");
    setProjects(d.projects || []);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await jget<{ models: Record<string, ModelDef>; env_set: Record<string, boolean> }>("/api/models");
      setModels(m.models);
      setEnvSet(m.env_set || {});
      const first = Object.keys(m.models).find((k) => m.models[k].active) || Object.keys(m.models)[0];
      setModelKey(first);
      const opt = m.models[first]?.options?.find((o) => o.key === "prompt_optimizer");
      setOptimizer(opt?.default !== false);
      await loadProjects();
    })().catch(console.error);
  }, [loadProjects]);

  useEffect(() => {
    if (!project) {
      setScenario(null);
      setPreflightTxt("");
      return;
    }
    const p = projects.find((x) => x.name === project);
    if (p?.keyframes_source) setKeyframesSource(p.keyframes_source);
    jget<{
      scenario: string;
      scene_count: number;
      warnings: string[];
      keyframes_source?: KeyframesSource;
    }>(`/api/project/${encodeURIComponent(project)}/preflight`)
      .then((d) => {
        setScenario(d.scenario);
        if (d.keyframes_source) setKeyframesSource(d.keyframes_source);
        const scLbl: Record<string, string> = {
          A: "Senaryo A (prompt hazır)",
          B: "Senaryo B (Gemini üretecek)",
          "B-eksik": "Senaryo B — EKSİK (video yok)",
        };
        const w = d.warnings || [];
        const src = d.keyframes_source === "swapped" ? "swapped" : "original";
        setPreflightTxt(
          `${d.scene_count} sahne · ${scLbl[d.scenario] || ""} · kf=${src}` +
            (w.length ? ` · ⚠ ${w.length} uyarı` : "") +
            (p ? "" : ""),
        );
      })
      .catch(() => setScenario(null));
  }, [project, projects]);

  const missing = useMemo(() => {
    const out: string[] = [];
    if (!model?.active) return ["bu model henüz aktif değil"];
    for (const cr of model.credentials) {
      if (cr.required && !creds[cr.key]?.trim()) out.push(cr.label);
    }
    if (!project) out.push("Üretilecek Proje seç");
    if (scenario === "B" && !envSet.GEMINI_API_KEY) out.push("GEMINI_API_KEY yok");
    if (scenario === "B-eksik") out.push("proje eksik: prompt yok ve kaynak video yok");
    return out;
  }, [model, creds, project, scenario, envSet]);

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
    try {
      const fd = new FormData();
      fd.append("project", name);
      fd.append("scenes", dropScenes);
      fd.append("keyframes_zip", dropZip);
      fd.append("keyframes_source", uploadSource);
      if (dropVideo) fd.append("video", dropVideo);
      const r = await fetch("/api/ingest", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      setUploadMsg(`✓ ${d.project} yüklendi (${d.keyframes_source || uploadSource})`);
      setDropScenes(null);
      setDropZip(null);
      setDropVideo(null);
      setKeyframesSource(uploadSource);
      await loadProjects();
      setProject(d.project);
    } catch (e) {
      setUploadMsg(`Yükleme hatası: ${e instanceof Error ? e.message : e}`);
    } finally {
      setUploading(false);
    }
  }

  const keyTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function onKey(k: string, v: string) {
    clearTimeout(keyTimers.current[k]);
    keyTimers.current[k] = setTimeout(async () => {
      const { d } = await jpost<Record<string, boolean>>("/api/keys", { [k]: v });
      setEnvSet(d);
    }, 400);
  }

  useEffect(() => {
    const t = creds.token?.trim();
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
  }, [creds.token]);

  function startPolling(name: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const d = await jget<Record<string, unknown>>(`/api/progress/${encodeURIComponent(name)}`);
        setProgress(d);
        const phase = d.phase as string | null;
        if (!phase || ["bitti", "hata", "durduruldu"].includes(phase)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setCurrent(null);
          setLiveOn(false);
          setLiveTxt(phase || "tamam");
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

  async function onStart() {
    setStartMsg("başlatılıyor…");
    const { ok, status, d } = await jpost<{ detail?: string; pid?: number }>("/api/start", {
      project,
      provider: modelKey,
      variants: "v1,v2,v3",
      concurrency,
      scenes: scenes.trim() || null,
      credentials: creds,
      prompt_optimizer: optimizer,
      keyframes_source: keyframesSource,
    });
    if (!ok) {
      setStartMsg(`${status}: ${(d as { detail?: string }).detail || "hata"}`);
      return;
    }
    setStartMsg(`başladı (pid ${d.pid})`);
    setCurrent(project);
    startPolling(project);
  }

  const pmeta = projects.find((p) => p.name === project);

  return (
    <div className="wrap">
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
              hint="prompt yoksa Gemini için .mp4 / .mov"
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
            {(["GEMINI_API_KEY", "ANTHROPIC_API_KEY"] as const).map((k) => (
              <label key={k} className="fld">
                <span>
                  {k}{" "}
                  <span className={`badge ${envSet[k] ? "b-ok" : "b-warn"}`}>{envSet[k] ? "✓ var" : "✗ yok"}</span>
                </span>
                <input
                  type="password"
                  placeholder={k === "GEMINI_API_KEY" ? "AIza…" : "sk-ant…"}
                  onChange={(e) => void onKey(k, e.target.value)}
                />
              </label>
            ))}
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

          {model?.credentials.map((cr) => (
            <label key={cr.key} className="fld">
              <span>{cr.label}{cr.required ? " *" : ""}</span>
              <input
                type={cr.secret ? "password" : "text"}
                value={creds[cr.key] || ""}
                onChange={(e) => setCreds((c) => ({ ...c, [cr.key]: e.target.value }))}
              />
              {cr.key === "token" && tokMsg && (
                <div className="tokline">
                  <span className="mono-sm">{mask(creds.token || "")}</span>
                  <span className={`badge ${tokOk === true ? "b-ok" : tokOk === false ? "b-err" : "b-warn"}`}>{tokMsg}</span>
                </div>
              )}
            </label>
          ))}

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
                <span className={`badge ${pmeta.has_prompts ? "b-ok" : "b-warn"}`}>
                  prompt {pmeta.has_prompts ? "✓" : "üretilecek"}
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

          <div className="row">
            <label className="fld">
              <span>Eşzamanlılık</span>
              <input type="number" min={1} max={6} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value) || 2)} />
            </label>
            <label className="fld">
              <span>Sahneler</span>
              <input value={scenes} onChange={(e) => setScenes(e.target.value)} placeholder="örn: 1-2" />
            </label>
          </div>

          <button className="primary" disabled={missing.length > 0 || !!current} onClick={() => void onStart()}>
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
                await jpost("/api/open", { project: progress.project, target: "videos" });
              }}
            />
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

  return (
    <div>
      <div className="phase">
        <span className={`pill ${pcls}`}>{ptxt}</span>
        <span className="mono-sm">{String(d.project)}</span>
      </div>
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
