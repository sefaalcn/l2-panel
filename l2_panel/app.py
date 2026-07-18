"""
l2_panel/app.py — L2.5 panel (FastAPI).
================================================================================
LOCAL: yerel PROJECTS_ROOT + subprocess l2_run (eski işleyiş).
CLOUD: Google Drive projeler + job kuyruğu; uzun koşu worker'da (gemini_direct/run_hailuo aynı).

Üretim motoru (prompt / v2 / Hailuo gönderimi) değişmez — yalnız I/O + hosting ayrımı.
"""
import os
import sys
import time
import json
import signal
import pathlib
import subprocess
import tempfile
import shutil
from typing import Optional
from collections import Counter

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from l2_panel.config import (
    PROJECTS_ROOT, CODE_ROOT, MODELS, COMMON_ENV, RUNTIME, DRIVE_ROOT_ID,
)
sys.path.insert(0, str(CODE_ROOT))
import hailuo_pipeline as hp
from video_router import runner, router, core   # GERCEK validasyon (kopya YOK)
from video_router import adapters  # noqa: F401 — registry doldur
from l2_panel import runstate

app = FastAPI(title="L2.5 Panel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
ROOT = pathlib.Path(PROJECTS_ROOT)
PANEL_DIR = pathlib.Path(__file__).resolve().parent
PROJECT_ROOT = str(CODE_ROOT)

# ZOMBIE ONLE (local): detached wrapper cikinca uvicorn parent onu reap etmezse zombie kalir.
try:
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
except (ValueError, OSError, AttributeError):
    pass
L2_CRED_FILES = [".l2_token.txt", ".l2_cookie.txt", ".l2_project.txt"]


def _clean_stale_creds():
    for f in L2_CRED_FILES:
        try:
            (PANEL_DIR / f).unlink()
        except OSError:
            pass


def _is_cloud() -> bool:
    return RUNTIME == "cloud"


# API key'leri: OTURUM BELLEGI (RAM). DISKE/LOG'A ASLA.
_SESSION_KEYS = {}
_KEY_NAMES = ("GEMINI_API_KEY", "ANTHROPIC_API_KEY")


def _key_present(k):
    return bool(_SESSION_KEYS.get(k) or os.environ.get(k, "").strip())


def _key_value(k):
    return _SESSION_KEYS.get(k) or os.environ.get(k, "").strip()


def _source_scenes_json(proj: pathlib.Path):
    cands = [p for p in proj.glob("*scenes*.json")
             if "_output" not in str(p) and "progress" not in p.name.lower()]
    return cands[0] if cands else None


def _load_scenes(path: pathlib.Path):
    d = json.loads(path.read_text(encoding="utf-8"))
    sc = d if isinstance(d, list) else d.get("scenes", [])
    return d, sc


def _prompts_json(proj: pathlib.Path):
    p = proj / f"{proj.name}_output" / "hailuo_prompts_claude.json"
    return p if p.exists() else None


def _project_summary(proj: pathlib.Path):
    src = _source_scenes_json(proj)
    kf = proj / "keyframes"
    prompts = _prompts_json(proj)
    n_scenes = None
    version = None
    if src:
        try:
            d, sc = _load_scenes(src)
            n_scenes = len(sc)
            version = d.get("version") if isinstance(d, dict) else None
        except Exception:
            pass
    return {
        "name": proj.name,
        "has_scenes_json": bool(src),
        "scenes_json": src.name if src else None,
        "version": version,
        "has_keyframes": kf.is_dir() and any(kf.iterdir()) if kf.is_dir() else False,
        "has_prompts": bool(prompts),
        "scene_count": n_scenes,
    }


def _preflight_from_local(name: str, proj: pathlib.Path, provider: str,
                          has_prompts: bool, has_video: bool, has_kf: bool):
    src = _source_scenes_json(proj)
    kf = proj / "keyframes"
    if not src:
        return {"name": name, "scene_count": None, "warnings": ["kaynak scenes JSON yok"],
                "unknown_fields": [], "unread_known_fields": [],
                "prompts_ready": has_prompts, "has_video": has_video, "scenario": "B-eksik"}

    d, sc = _load_scenes(src)
    n = len(sc)
    frame_modes = dict(Counter(s.get("frame_mode") for s in sc))
    dur_dist = dict(Counter(s.get("video_duration") for s in sc))

    scene_warnings = []
    start_only_ord = 0
    for s in sc:
        mode = s.get("frame_mode", "both")
        label = s.get("label", f"scene_{s.get('index', 0):03d}")
        ordinal = start_only_ord
        if mode == "start_only":
            start_only_ord += 1
        try:
            adapter_key = router.route(provider, mode, ordinal, "kling")
            spec = core.get(adapter_key)
            model_tag = spec.model_tag
        except Exception:
            model_tag = None
        sdir = kf / label
        for w in runner._validate_scene(s, mode, sdir / "frame_first.jpg", sdir / "frame_last.jpg", model_tag):
            scene_warnings.append(f"{label}: {w}")

    _, unknown = runner.unknown_fields(sc)

    extra = []
    if not has_kf:
        extra.append("keyframes/ boş veya yok — Studio keyframes.zip gerekli")
    if has_prompts:
        scenario = "A"
    elif has_video:
        scenario = "B"
        extra.append("prompt YOK → gemini_direct üretecek (kaynak video ✓; GEMINI_API_KEY ile paneli başlat)")
    else:
        scenario = "B-eksik"
        extra.append("prompt YOK ve kaynak video (.mp4) YOK → prompt üretilemez (video ekle ya da hazır prompt koy)")

    return {
        "name": name,
        "scene_count": n,
        "frame_mode_dist": frame_modes,
        "video_duration_dist": dur_dist,
        "prompts_ready": has_prompts,
        "has_video": has_video,
        "scenario": scenario,
        "warnings": (extra + scene_warnings)[:30],
        "schema_unknown_fields": unknown,
    }


def _progress_from_data(project: str, prog: dict, warnings: list, phase, alive: bool):
    counts = {"done": 0, "submitted": 0, "error": 0, "other": 0}
    producing, softened, errors = [], [], []
    for k, v in (prog or {}).items():
        if not isinstance(v, dict):
            continue
        st = (v.get("status") or "").lower()
        scene = v.get("scene") or k
        if st == "done":
            counts["done"] += 1
        elif st == "submitted":
            counts["submitted"] += 1
            producing.append(scene)
        elif st in ("error", "failed"):
            counts["error"] += 1
            errors.append({"scene": scene, "error": (v.get("error") or "")[:120]})
        else:
            counts["other"] += 1
        if v.get("softened"):
            softened.append({"scene": scene, "attempt": v.get("soften_attempt")})
    return {
        "project": project,
        "phase": phase,
        "alive": alive,
        "counts": counts,
        "producing": producing,
        "softened": softened,
        "errors": errors,
        "warnings": warnings[-15:],
        "runtime": RUNTIME,
    }


_WARN_TAGS = ("[UYARI", "[S4", "[ALAN", "[DOGRULAMA", "BASARISIZ", "2400001", "2400002")


# ---- endpoint'ler ----
@app.get("/", response_class=HTMLResponse)
def index():
    return (PANEL_DIR / "static" / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    return {
        "ok": True,
        "runtime": RUNTIME,
        "drive": _is_cloud(),
        "code_root": PROJECT_ROOT,
        "projects_root": str(ROOT),
        "ingest": True,
    }


def _check_ingest_auth(
    authorization: Optional[str],
    x_l2_ingest_token: Optional[str],
):
    """L2_INGEST_TOKEN set ise Bearer veya X-L2-Ingest-Token zorunlu."""
    expected = (os.environ.get("L2_INGEST_TOKEN") or "").strip()
    if not expected:
        return
    got = (x_l2_ingest_token or "").strip()
    if not got and authorization:
        parts = authorization.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            got = parts[1].strip()
    if got != expected:
        raise HTTPException(401, "ingest token geçersiz")


@app.post("/ingest")
async def ingest(
    project: str = Form(...),
    scenes: UploadFile = File(...),
    keyframes_zip: UploadFile = File(...),
    video: Optional[UploadFile] = File(None),
    authorization: Optional[str] = Header(None),
    x_l2_ingest_token: Optional[str] = Header(None, alias="X-L2-Ingest-Token"),
):
    """
    Sürükle-bırak / Studio köprüsü.
    multipart: project, scenes (JSON), keyframes_zip, video? (mp4)
    Her zaman PROJECTS_ROOT/<project>/ altına yazar (Drive yok — panelden yükle).
    """
    _check_ingest_auth(authorization, x_l2_ingest_token)
    from l2_panel.ingest import materialize_export, _safe_project_name

    project = _safe_project_name(project)
    scenes_bytes = await scenes.read()
    zip_bytes = await keyframes_zip.read()
    if not scenes_bytes:
        raise HTTPException(400, "scenes boş")
    if not zip_bytes:
        raise HTTPException(400, "keyframes_zip boş")

    video_bytes = None
    video_name = None
    if video is not None:
        video_bytes = await video.read()
        video_name = video.filename
        if not video_bytes:
            video_bytes = None

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="l2_ingest_"))
    try:
        info = materialize_export(
            tmp,
            project=project,
            scenes_bytes=scenes_bytes,
            zip_bytes=zip_bytes,
            video_bytes=video_bytes,
            video_name=video_name,
        )
        local_proj = pathlib.Path(info["path"])

        # Her zaman yerel projects/ — Drive kullanılmaz
        ROOT.mkdir(parents=True, exist_ok=True)
        dest = ROOT / project
        dest.mkdir(parents=True, exist_ok=True)
        for item in local_proj.iterdir():
            target = dest / item.name
            if item.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)
        return {
            "ok": True,
            "runtime": "local",
            "project": project,
            "path": str(dest),
            "has_keyframes": info["has_keyframes"],
            "video": info["video"],
            "extracted": info["extracted"],
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.get("/models")
def models():
    env_set = {e["key"]: _key_present(e["key"]) for e in COMMON_ENV}
    return {
        "models": MODELS,
        "common_env": COMMON_ENV,
        "env_set": env_set,
        "runtime": RUNTIME,
    }


class KeysReq(BaseModel):
    GEMINI_API_KEY: Optional[str] = None
    ANTHROPIC_API_KEY: Optional[str] = None


@app.post("/keys")
def set_keys(body: KeysReq):
    for k in _KEY_NAMES:
        v = getattr(body, k, None)
        if v is None:
            continue
        v = v.strip()
        if v:
            _SESSION_KEYS[k] = v
        else:
            _SESSION_KEYS.pop(k, None)
    return {k: _key_present(k) for k in _KEY_NAMES}


@app.get("/projects")
def projects():
    # Sürükle-bırak / ingest → PROJECTS_ROOT. Drive listesi kullanılmaz.
    if not ROOT.is_dir():
        ROOT.mkdir(parents=True, exist_ok=True)
    out = []
    for d in sorted(ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name == "OLD":
            continue
        s = _project_summary(d)
        has_video = any(
            "_small" not in p.stem and "_output" not in str(p.parent)
            for p in d.glob("*.mp4")
        )
        s["has_video"] = has_video
        if s["has_scenes_json"] or s["has_keyframes"] or has_video:
            out.append(s)
    return {"root": str(ROOT), "runtime": "local", "projects": out}


@app.get("/project/{name}/preflight")
def preflight(name: str, provider: str = "hailuo"):
    if _is_cloud():
        from l2_panel import drive as drv
        meta = drv.find_project_folder(name)
        if not meta:
            raise HTTPException(404, f"Drive proje yok: {name}")
        badges = drv.project_badges(meta["id"])
        # scenes + keyframes iskeleti /tmp'ye
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="l2_pf_"))
        try:
            scenes_path = drv.download_scenes_json(meta["id"], tmp)
            if not scenes_path:
                return {"name": name, "scene_count": None,
                        "warnings": ["kaynak scenes JSON yok"],
                        "prompts_ready": badges["has_prompts"],
                        "has_video": badges["has_video"], "scenario": "B-eksik"}
            # keyframe dosya yollarını lokal ağaç gibi taklit et
            kf_root = tmp / "keyframes"
            for rel in drv.list_keyframe_files(meta["id"]):
                p = kf_root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"")  # varlık kontrolü için boş placeholder
            # proje adı klasörü
            proj = tmp
            # _source_scenes_json tmp kökünde scenes dosyasını bulur
            return _preflight_from_local(
                name, proj, provider,
                has_prompts=badges["has_prompts"],
                has_video=badges["has_video"],
                has_kf=badges["has_keyframes"],
            )
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    proj = ROOT / name
    if not proj.is_dir():
        raise HTTPException(404, f"Proje yok: {name}")
    kf = proj / "keyframes"
    has_kf = kf.is_dir() and any(kf.iterdir())
    has_prompts = bool(_prompts_json(proj))
    has_video = any("_small" not in p.stem and "_output" not in str(p.parent) for p in proj.glob("*.mp4"))
    return _preflight_from_local(name, proj, provider, has_prompts, has_video, has_kf)


class TokenCheck(BaseModel):
    value: str


@app.post("/check-token")
def check_token(body: TokenCheck):
    v = (body.value or "").replace("Bearer ", "").strip()
    if not v:
        return {"valid": False, "message": "boş"}
    rem = hp._token_exp_remaining(v)
    if rem is None:
        return {"valid": None, "message": "JWT değil / expiry okunamadı (Firefly token olabilir)"}
    if rem <= 0:
        return {"valid": False, "expires_in_h": round(rem / 3600, 1), "message": "SÜRESİ DOLMUŞ — F12'den yenile"}
    return {"valid": True, "expires_in_h": round(rem / 3600, 1), "message": f"geçerli, {rem/3600:.1f}h kaldı"}


class StartReq(BaseModel):
    project: str
    provider: str = "hailuo"
    variants: str = "v1"
    concurrency: Optional[int] = None
    scenes: Optional[str] = None
    credentials: dict = {}
    prompt_optimizer: bool = True


@app.post("/start")
def start(req: StartReq):
    model = MODELS.get(req.provider)
    if not model:
        raise HTTPException(400, f"Bilinmeyen model: {req.provider}")

    # zorunlu credential kontrolü
    for cred in model["credentials"]:
        val = (req.credentials.get(cred["key"]) or "").strip()
        if cred["required"] and not val:
            raise HTTPException(400, f"{cred['label']} gerekli")

    if _is_cloud():
        from l2_panel import drive as drv
        from l2_panel import jobs as jobq
        if not drv.configured():
            raise HTTPException(500, "Cloud: Drive yapılandırması eksik")
        active = jobq.active_job()
        if active:
            raise HTTPException(409, f"zaten koşuyor: {active.get('project')} "
                                     f"(status={active.get('status')})")
        meta = drv.find_project_folder(req.project)
        if not meta:
            raise HTTPException(404, f"Drive proje yok: {req.project}")
        keys = {k: _key_value(k) for k in _KEY_NAMES if _key_value(k)}
        job = jobq.enqueue({
            "project": req.project,
            "folder_id": meta["id"],
            "provider": req.provider,
            "variants": req.variants,
            "concurrency": req.concurrency,
            "scenes": req.scenes,
            "credentials": req.credentials,
            "prompt_optimizer": req.prompt_optimizer,
            "keys": keys,
        })
        return {
            "project": req.project,
            "job_id": job["id"],
            "status": "queued",
            "runtime": "cloud",
            "message": "job kuyruğa alındı — worker işleyecek",
        }

    # ---- LOCAL (eski işleyiş) ----
    active = runstate.active_run()
    if active:
        raise HTTPException(409, f"zaten koşuyor: {active.get('project')} "
                                 f"(status={active.get('status')}, pid={active.get('pid')})")
    _clean_stale_creds()

    proj = ROOT / req.project
    if not proj.is_dir():
        raise HTTPException(404, f"Proje yok: {req.project}")

    env = dict(os.environ)
    env.update(_SESSION_KEYS)
    for cred in model["credentials"]:
        val = (req.credentials.get(cred["key"]) or "").strip()
        if not val:
            continue
        tgt = cred["target"]
        if tgt.get("type") == "file":
            fpath = PANEL_DIR / f".l2_{cred['key']}.txt"
            fpath.write_text(val, encoding="utf-8")
            env[tgt["env"]] = str(fpath)

    logf = proj / ".l2_run.log"
    cmd = [sys.executable, "-m", "l2_panel.l2_run", "--project-path", str(proj),
           "--provider", req.provider, "--variants", req.variants, "--log", str(logf)]
    if req.concurrency:
        cmd += ["--concurrency", str(req.concurrency)]
    if req.scenes:
        cmd += ["--scenes", req.scenes]
    if not req.prompt_optimizer:
        cmd += ["--no-optimizer"]
    p = subprocess.Popen(cmd, cwd=PROJECT_ROOT, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    runstate.write_runstate({"pid": p.pid, "project": req.project, "provider": req.provider,
                             "status": "basliyor", "started_at": time.time()})
    return {"project": req.project, "pid": p.pid, "status": "basliyor", "log": str(logf), "runtime": "local"}


class OpenReq(BaseModel):
    project: str
    target: str = "videos"


@app.post("/open")
def open_folder(req: OpenReq):
    if _is_cloud():
        from l2_panel import drive as drv
        meta = drv.find_project_folder(req.project)
        if not meta:
            raise HTTPException(404, f"Drive proje yok: {req.project}")
        url = drv.folder_url(meta["id"])
        if req.target == "videos":
            vids = drv.find_child_by_name(meta["id"], "hailuo_router_videos", folder=True)
            if vids:
                url = drv.folder_url(vids["id"])
        return {"opened": url, "url": url, "runtime": "cloud"}

    proj = ROOT / req.project
    if not proj.is_dir():
        raise HTTPException(404, f"Proje yok: {req.project}")
    folder = proj / "hailuo_router_videos" if req.target == "videos" else proj
    if not folder.is_dir():
        folder = proj
    # macOS open / Windows explorer / xdg
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        elif sys.platform == "win32":
            os.startfile(str(folder))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(folder)])
    except OSError as e:
        raise HTTPException(500, f"açılamadı: {e}")
    return {"opened": str(folder), "runtime": "local"}


@app.post("/stop")
def stop():
    if _is_cloud():
        from l2_panel import jobs as jobq
        job = jobq.request_stop()
        return {
            "stopped": bool(job),
            "job_id": job.get("id") if job else None,
            "message": "durdurma istendi" if job else "aktif koşu yok",
            "runtime": "cloud",
        }

    rs = runstate.read_runstate()
    pid = rs.get("pid") if rs else None
    stopped = False
    if pid and runstate.pid_alive(pid):
        try:
            os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
            stopped = True
        except (OSError, ValueError):
            try:
                os.kill(int(pid), signal.SIGTERM)
                stopped = True
            except OSError:
                pass
    _clean_stale_creds()
    runstate.clear_runstate()
    return {"stopped": stopped, "pid": pid,
            "message": "durduruldu" if stopped else "aktif koşu yok — temizlendi",
            "runtime": "local"}


@app.get("/progress/{project}")
def progress(project: str):
    if _is_cloud():
        from l2_panel import drive as drv
        from l2_panel import jobs as jobq
        meta = drv.find_project_folder(project)
        if not meta:
            raise HTTPException(404, f"Drive proje yok: {project}")
        prog = {}
        warnings = []
        # progress.json Drive'dan
        prog_file = drv.find_child_by_name(meta["id"], "hailuo_router_progress.json", folder=False)
        if prog_file:
            try:
                prog = drv.read_json_file(prog_file["id"])
            except Exception:
                prog = {}
        log_file = drv.find_child_by_name(meta["id"], ".l2_run.log", folder=False)
        if log_file:
            try:
                text = drv.download_bytes(log_file["id"]).decode("utf-8", errors="replace")
                for line in text.splitlines():
                    s = line.strip()
                    if any(t in s for t in _WARN_TAGS):
                        warnings.append(s)
            except Exception:
                pass
        phase, alive = None, False
        for j in jobq.list_jobs():
            if j.get("project") == project and j.get("status") not in ("bitti", "hata", "durduruldu"):
                phase = j.get("phase") or j.get("status")
                alive = j.get("status") in ("queued", "running", "basliyor", "prompt_uretiliyor",
                                            "video_uretiliyor", "durduruluyor")
                break
            if j.get("project") == project:
                phase = j.get("phase") or j.get("status")
        return _progress_from_data(project, prog, warnings, phase, alive)

    proj = ROOT / project
    if not proj.is_dir():
        raise HTTPException(404, f"Proje yok: {project}")

    prog = {}
    prog_file = proj / "hailuo_router_progress.json"
    if prog_file.exists():
        try:
            prog = json.loads(prog_file.read_text(encoding="utf-8"))
        except Exception:
            prog = {}

    warnings = []
    logf = proj / ".l2_run.log"
    if logf.exists():
        for line in logf.read_text(encoding="utf-8", errors="replace").splitlines():
            s = line.strip()
            if any(t in s for t in _WARN_TAGS):
                warnings.append(s)

    phase, alive = None, False
    rs = runstate.read_runstate()
    if rs and rs.get("project") == project:
        phase = rs.get("status")
        alive = runstate.pid_alive(rs.get("pid"))

    return _progress_from_data(project, prog, warnings, phase, alive)
