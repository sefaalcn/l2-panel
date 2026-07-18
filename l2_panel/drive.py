"""
l2_panel/drive.py — Google Drive I/O (proje listele / indir / yükle).
================================================================================
Service account: GOOGLE_SERVICE_ACCOUNT_JSON (JSON string) veya GOOGLE_APPLICATION_CREDENTIALS (dosya yolu).
Kök klasör: L2_DRIVE_ROOT_ID (config.DRIVE_ROOT_ID).
Üretim motoruna (gemini_direct / run_hailuo) dokunmaz — yalnız dosya taşıma.
"""
from __future__ import annotations

import io
import json
import os
import pathlib
from typing import Optional

from l2_panel.config import DRIVE_ROOT_ID

SCOPES = ["https://www.googleapis.com/auth/drive"]
JOBS_FOLDER_NAME = "_l2_jobs"
MIME_FOLDER = "application/vnd.google-apps.folder"

_service = None


def configured() -> bool:
    return bool(DRIVE_ROOT_ID) and bool(
        os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    )


def _creds():
    from google.oauth2 import service_account

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw:
        info = json.loads(raw)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if path and os.path.isfile(path):
        return service_account.Credentials.from_service_account_file(path, scopes=SCOPES)
    raise RuntimeError(
        "Drive kimliği yok: GOOGLE_SERVICE_ACCOUNT_JSON veya GOOGLE_APPLICATION_CREDENTIALS ayarla"
    )


def service():
    global _service
    if _service is None:
        from googleapiclient.discovery import build
        _service = build("drive", "v3", credentials=_creds(), cache_discovery=False)
    return _service


def folder_url(folder_id: str) -> str:
    return f"https://drive.google.com/drive/folders/{folder_id}"


def _list_children(parent_id: str, *, folders_only=False, files_only=False, name=None):
    svc = service()
    q = [f"'{parent_id}' in parents", "trashed=false"]
    if folders_only:
        q.append(f"mimeType='{MIME_FOLDER}'")
    if files_only:
        q.append(f"mimeType!='{MIME_FOLDER}'")
    if name:
        safe = name.replace("\\", "\\\\").replace("'", "\\'")
        q.append(f"name='{safe}'")
    out, token = [], None
    while True:
        resp = svc.files().list(
            q=" and ".join(q),
            spaces="drive",
            fields="nextPageToken, files(id, name, mimeType, modifiedTime, size)",
            pageToken=token,
            pageSize=200,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        out.extend(resp.get("files", []))
        token = resp.get("nextPageToken")
        if not token:
            break
    return out


def ensure_jobs_folder() -> str:
    """Kök altında _l2_jobs klasörünü bul veya oluştur."""
    kids = _list_children(DRIVE_ROOT_ID, folders_only=True, name=JOBS_FOLDER_NAME)
    if kids:
        return kids[0]["id"]
    meta = {"name": JOBS_FOLDER_NAME, "mimeType": MIME_FOLDER, "parents": [DRIVE_ROOT_ID]}
    created = service().files().create(
        body=meta, fields="id", supportsAllDrives=True
    ).execute()
    return created["id"]


def list_project_folders() -> list[dict]:
    """Drive kökündeki proje klasörleri (OLD / _l2_jobs hariç)."""
    folders = _list_children(DRIVE_ROOT_ID, folders_only=True)
    out = []
    for f in folders:
        name = f["name"]
        if name.startswith(".") or name in ("OLD", JOBS_FOLDER_NAME):
            continue
        out.append({"name": name, "id": f["id"], "modifiedTime": f.get("modifiedTime")})
    out.sort(key=lambda x: x["name"].lower())
    return out


def find_project_folder(name: str) -> Optional[dict]:
    for f in list_project_folders():
        if f["name"] == name:
            return f
    return None


def ensure_project_folder(name: str) -> str:
    """Kök altında proje klasörü yoksa oluştur; id döner."""
    found = find_project_folder(name)
    if found:
        return found["id"]
    if not DRIVE_ROOT_ID:
        raise RuntimeError("L2_DRIVE_ROOT_ID yok")
    meta = {"name": name, "mimeType": MIME_FOLDER, "parents": [DRIVE_ROOT_ID]}
    return service().files().create(
        body=meta, fields="id", supportsAllDrives=True
    ).execute()["id"]


def upload_tree(local_dir: pathlib.Path, folder_id: str):
    """Yerel klasör ağacını Drive'a yazar (var olan dosyaları günceller)."""
    for item in sorted(local_dir.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if item.name.startswith("."):
            continue
        if item.is_dir():
            sub = ensure_subfolder(folder_id, item.name)
            upload_tree(item, sub)
        elif item.is_file():
            upload_file(item, folder_id)


def project_badges(folder_id: str) -> dict:
    """İndirmeden rozet: scenes json / keyframes / prompts."""
    kids = _list_children(folder_id)
    has_scenes = False
    scenes_name = None
    has_keyframes = False
    has_prompts = False
    has_video = False
    for k in kids:
        n = k["name"]
        low = n.lower()
        if k["mimeType"] == MIME_FOLDER:
            if n == "keyframes":
                has_keyframes = True
            continue
        if "scenes" in low and low.endswith(".json") and "progress" not in low and "_output" not in low:
            has_scenes = True
            scenes_name = n
        if low.endswith(".mp4") and "_small" not in low:
            has_video = True
        if n.endswith("_output") or False:
            pass
    # prompts: <name>_output/hailuo_prompts_claude.json
    for k in kids:
        if k["mimeType"] == MIME_FOLDER and k["name"].endswith("_output"):
            inner = _list_children(k["id"], files_only=True)
            if any(f["name"] == "hailuo_prompts_claude.json" for f in inner):
                has_prompts = True
            break
    return {
        "has_scenes_json": has_scenes,
        "scenes_json": scenes_name,
        "has_keyframes": has_keyframes,
        "has_prompts": has_prompts,
        "has_video": has_video,
    }


def download_file(file_id: str, dest: pathlib.Path):
    from googleapiclient.http import MediaIoBaseDownload

    dest.parent.mkdir(parents=True, exist_ok=True)
    req = service().files().get_media(fileId=file_id, supportsAllDrives=True)
    with open(dest, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, req)
        done = False
        while not done:
            _, done = downloader.next_chunk()


def download_bytes(file_id: str) -> bytes:
    from googleapiclient.http import MediaIoBaseDownload

    req = service().files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()


def _download_tree(folder_id: str, dest: pathlib.Path):
    dest.mkdir(parents=True, exist_ok=True)
    for item in _list_children(folder_id):
        target = dest / item["name"]
        if item["mimeType"] == MIME_FOLDER:
            _download_tree(item["id"], target)
        else:
            download_file(item["id"], target)


def download_project(folder_id: str, dest: pathlib.Path):
    """Proje klasörünün tamamını lokale indir (worker)."""
    if dest.exists():
        import shutil
        shutil.rmtree(dest)
    _download_tree(folder_id, dest)


def find_child_by_name(parent_id: str, name: str, *, folder=False) -> Optional[dict]:
    kids = _list_children(parent_id, folders_only=folder, name=name)
    return kids[0] if kids else None


def ensure_subfolder(parent_id: str, name: str) -> str:
    found = find_child_by_name(parent_id, name, folder=True)
    if found:
        return found["id"]
    meta = {"name": name, "mimeType": MIME_FOLDER, "parents": [parent_id]}
    return service().files().create(
        body=meta, fields="id", supportsAllDrives=True
    ).execute()["id"]


def upload_file(local_path: pathlib.Path, parent_id: str, name: Optional[str] = None) -> str:
    from googleapiclient.http import MediaFileUpload

    name = name or local_path.name
    existing = find_child_by_name(parent_id, name, folder=False)
    media = MediaFileUpload(str(local_path), resumable=True)
    if existing:
        updated = service().files().update(
            fileId=existing["id"],
            media_body=media,
            supportsAllDrives=True,
        ).execute()
        return updated["id"]
    meta = {"name": name, "parents": [parent_id]}
    created = service().files().create(
        body=meta, media_body=media, fields="id", supportsAllDrives=True
    ).execute()
    return created["id"]


def upload_json(parent_id: str, name: str, data: dict) -> str:
    """Küçük JSON'u bellektan yükle (job dosyaları)."""
    from googleapiclient.http import MediaIoBaseUpload

    raw = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    media = MediaIoBaseUpload(io.BytesIO(raw), mimetype="application/json", resumable=False)
    existing = find_child_by_name(parent_id, name, folder=False)
    if existing:
        service().files().update(
            fileId=existing["id"], media_body=media, supportsAllDrives=True
        ).execute()
        return existing["id"]
    meta = {"name": name, "parents": [parent_id]}
    return service().files().create(
        body=meta, media_body=media, fields="id", supportsAllDrives=True
    ).execute()["id"]


def read_json_file(file_id: str) -> dict:
    return json.loads(download_bytes(file_id).decode("utf-8"))


def upload_project_outputs(local_proj: pathlib.Path, folder_id: str):
    """Koşu sonrası progress / log / videolar / prompt çıktısını Drive'a yaz."""
    # progress + log
    for fname in ("hailuo_router_progress.json", ".l2_run.log"):
        p = local_proj / fname
        if p.is_file():
            upload_file(p, folder_id)

    # prompts output dir
    out_dir = local_proj / f"{local_proj.name}_output"
    if out_dir.is_dir():
        out_id = ensure_subfolder(folder_id, out_dir.name)
        for f in out_dir.iterdir():
            if f.is_file():
                upload_file(f, out_id)

    # videos
    vids = local_proj / "hailuo_router_videos"
    if vids.is_dir():
        vids_id = ensure_subfolder(folder_id, "hailuo_router_videos")
        for f in vids.rglob("*"):
            if f.is_file():
                # relative subdirs
                rel = f.relative_to(vids)
                parent = vids_id
                if len(rel.parts) > 1:
                    cur = vids_id
                    for part in rel.parts[:-1]:
                        cur = ensure_subfolder(cur, part)
                    parent = cur
                upload_file(f, parent, name=rel.name)


def download_scenes_json(folder_id: str, dest_dir: pathlib.Path) -> Optional[pathlib.Path]:
    """Preflight için yalnız scenes JSON + keyframes isim listesi yeterli olacak şekilde scenes indir."""
    kids = _list_children(folder_id)
    scenes = None
    for k in kids:
        n = k["name"].lower()
        if (
            k["mimeType"] != MIME_FOLDER
            and "scenes" in n
            and n.endswith(".json")
            and "progress" not in n
            and "_output" not in n
        ):
            scenes = k
            break
    if not scenes:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / scenes["name"]
    download_file(scenes["id"], path)
    return path


def list_keyframe_files(folder_id: str) -> list[str]:
    """keyframes/ altındaki göreli yollar (scene_001/frame_first.jpg …)."""
    kf = find_child_by_name(folder_id, "keyframes", folder=True)
    if not kf:
        return []
    paths = []

    def walk(fid, prefix=""):
        for item in _list_children(fid):
            rel = f"{prefix}{item['name']}" if not prefix else f"{prefix}/{item['name']}"
            if item["mimeType"] == MIME_FOLDER:
                walk(item["id"], rel)
            else:
                paths.append(rel)

    walk(kf["id"])
    return paths
