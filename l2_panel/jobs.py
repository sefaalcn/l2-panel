"""
l2_panel/jobs.py — Drive tabanlı iş kuyruğu (Vercel panel ↔ worker).
================================================================================
Job dosyaları: Drive {_l2_jobs}/{id}.json
Panel enqueue eder; worker claim eder; progress/status Drive'da güncellenir.
gemini_direct / run_hailuo çağrıları worker içinde (l2_run) — burada yok.
"""
from __future__ import annotations

import time
import uuid
from typing import Optional

from l2_panel import drive as drv


def _jobs_parent() -> str:
    return drv.ensure_jobs_folder()


def enqueue(job: dict) -> dict:
    jid = job.get("id") or str(uuid.uuid4())
    now = time.time()
    payload = {
        **job,
        "id": jid,
        "status": "queued",
        "stop_requested": False,
        "created_at": now,
        "updated_at": now,
    }
    # credentials job içinde (Drive klasörü private olmalı)
    file_id = drv.upload_json(_jobs_parent(), f"{jid}.json", payload)
    payload["_drive_file_id"] = file_id
    return payload


def list_jobs() -> list[dict]:
    parent = _jobs_parent()
    files = drv._list_children(parent, files_only=True)
    out = []
    for f in files:
        if not f["name"].endswith(".json"):
            continue
        try:
            data = drv.read_json_file(f["id"])
            data["_drive_file_id"] = f["id"]
            out.append(data)
        except Exception:
            continue
    out.sort(key=lambda x: x.get("created_at") or 0)
    return out


def get_job(job_id: str) -> Optional[dict]:
    for j in list_jobs():
        if j.get("id") == job_id:
            return j
    return None


def active_job() -> Optional[dict]:
    for j in list_jobs():
        if j.get("status") in ("queued", "running", "basliyor", "prompt_uretiliyor", "video_uretiliyor"):
            return j
    return None


def update_job(job_id: str, **fields) -> dict:
    job = get_job(job_id)
    if not job:
        raise KeyError(job_id)
    file_id = job.pop("_drive_file_id", None)
    job.update(fields)
    job["updated_at"] = time.time()
    if not file_id:
        # yeniden bul
        parent = _jobs_parent()
        found = drv.find_child_by_name(parent, f"{job_id}.json", folder=False)
        if not found:
            raise KeyError(job_id)
        file_id = found["id"]
    drv.upload_json(_jobs_parent(), f"{job_id}.json", job)
    job["_drive_file_id"] = file_id
    return job


def request_stop() -> Optional[dict]:
    job = active_job()
    if not job:
        return None
    return update_job(job["id"], stop_requested=True, status="durduruluyor")


def claim_next() -> Optional[dict]:
    """Worker: ilk queued işi running yap."""
    for j in list_jobs():
        if j.get("status") == "queued":
            return update_job(j["id"], status="running", claimed_at=time.time())
    return None
