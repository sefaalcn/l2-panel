"""
l2_panel/worker.py — Uzun ömürlü worker (Docker yok).
================================================================================
Vercel paneli job kuyruğuna yazar; bu process:
  1) queued job claim
  2) Drive'dan proje indir → SCRATCH
  3) mevcut l2_run (gemini_direct → run_hailuo) çalıştır — motor aynı
  4) çıktıları Drive'a yükle
  5) job status güncelle

Kullanım:
  L2_DRIVE_ROOT_ID=... GOOGLE_APPLICATION_CREDENTIALS=sa.json \\
  python -m l2_panel.worker
"""
from __future__ import annotations

import os
import sys
import time
import signal
import pathlib
import subprocess

from l2_panel.config import CODE_ROOT, SCRATCH_ROOT, MODELS
from l2_panel import drive as drv
from l2_panel import jobs as jobq

POLL_SEC = float(os.environ.get("L2_WORKER_POLL_SEC", "8"))
PANEL_DIR = pathlib.Path(__file__).resolve().parent
_current_proc = None
_current_job_id = None


def _py():
    return sys.executable


def _write_creds(credentials: dict, provider: str) -> dict:
    """Hailuo token/cookie/project → .l2_*.txt + env (l2_run ile aynı desen)."""
    model = MODELS.get(provider) or MODELS["hailuo"]
    env = dict(os.environ)
    for cred in model["credentials"]:
        val = (credentials.get(cred["key"]) or "").strip()
        if not val:
            continue
        tgt = cred.get("target") or {}
        if tgt.get("type") == "file" and tgt.get("env"):
            fpath = PANEL_DIR / f".l2_{cred['key']}.txt"
            fpath.write_text(val, encoding="utf-8")
            env[tgt["env"]] = str(fpath)
    return env


def _cleanup_creds():
    for name in (".l2_token.txt", ".l2_cookie.txt", ".l2_project.txt"):
        try:
            (PANEL_DIR / name).unlink()
        except OSError:
            pass


def _sync_job_phase(job_id: str):
    """l2_run runstate dosyasından fazı Drive job'a yansıt."""
    from l2_panel import runstate
    rs = runstate.read_runstate()
    if not rs:
        return
    status = rs.get("status")
    if status:
        try:
            jobq.update_job(job_id, status=status, phase=status, error=rs.get("error"))
        except Exception:
            pass


def run_one(job: dict):
    global _current_proc, _current_job_id
    jid = job["id"]
    _current_job_id = jid
    project = job["project"]
    folder_id = job.get("folder_id")
    if not folder_id:
        meta = drv.find_project_folder(project)
        if not meta:
            jobq.update_job(jid, status="hata", error=f"Drive proje yok: {project}")
            return
        folder_id = meta["id"]

    scratch = pathlib.Path(SCRATCH_ROOT) / project
    scratch.parent.mkdir(parents=True, exist_ok=True)

    try:
        jobq.update_job(jid, status="basliyor", phase="drive_indiriliyor")
        print(f"[worker] indiriliyor {project} → {scratch}", flush=True)
        drv.download_project(folder_id, scratch)

        env = _write_creds(job.get("credentials") or {}, job.get("provider") or "hailuo")
        # API keys job veya env
        for k in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY"):
            if job.get("keys", {}).get(k):
                env[k] = job["keys"][k]

        logf = scratch / ".l2_run.log"
        cmd = [
            _py(), "-m", "l2_panel.l2_run",
            "--project-path", str(scratch),
            "--provider", job.get("provider") or "hailuo",
            "--variants", job.get("variants") or "v1",
            "--log", str(logf),
        ]
        if job.get("concurrency"):
            cmd += ["--concurrency", str(job["concurrency"])]
        if job.get("scenes"):
            cmd += ["--scenes", job["scenes"]]
        if job.get("prompt_optimizer") is False:
            cmd += ["--no-optimizer"]

        print(f"[worker] koşu: {' '.join(cmd)}", flush=True)
        _current_proc = subprocess.Popen(
            cmd, cwd=str(CODE_ROOT), env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        while True:
            # stop isteği
            fresh = jobq.get_job(jid)
            if fresh and fresh.get("stop_requested") and _current_proc.poll() is None:
                try:
                    os.killpg(os.getpgid(_current_proc.pid), signal.SIGTERM)
                except (OSError, AttributeError, ValueError):
                    _current_proc.terminate()
                jobq.update_job(jid, status="durduruldu")
                break

            _sync_job_phase(jid)
            # ara progress yükle
            if (scratch / "hailuo_router_progress.json").exists():
                try:
                    drv.upload_file(scratch / "hailuo_router_progress.json", folder_id)
                except Exception as e:
                    print(f"[worker] progress upload: {e}", flush=True)

            rc = _current_proc.poll()
            if rc is not None:
                break
            time.sleep(5)

        rc = _current_proc.wait() if _current_proc.poll() is None else _current_proc.returncode
        print(f"[worker] bitti rc={rc}; Drive'a yükleniyor", flush=True)
        drv.upload_project_outputs(scratch, folder_id)

        if jobq.get_job(jid) and jobq.get_job(jid).get("status") == "durduruldu":
            pass
        else:
            jobq.update_job(
                jid,
                status="bitti" if rc == 0 else "hata",
                rc=rc,
                phase="bitti" if rc == 0 else "hata",
            )
    except Exception as e:
        jobq.update_job(jid, status="hata", error=str(e)[:500])
        print(f"[worker] HATA: {e}", flush=True)
    finally:
        _cleanup_creds()
        _current_proc = None
        _current_job_id = None


def main():
    if not drv.configured():
        print("Drive yapılandırması eksik (L2_DRIVE_ROOT_ID + service account).", file=sys.stderr)
        sys.exit(1)
    print(f"[worker] polling her {POLL_SEC}s | scratch={SCRATCH_ROOT}", flush=True)
    while True:
        try:
            job = jobq.claim_next()
            if job:
                run_one(job)
            else:
                time.sleep(POLL_SEC)
        except KeyboardInterrupt:
            print("[worker] çıkış", flush=True)
            break
        except Exception as e:
            print(f"[worker] loop hata: {e}", flush=True)
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
