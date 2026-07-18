"""
l2_panel/ingest.py — Studio'dan gelen export'u proje klasörüne yerleştir.
================================================================================
Girdi: scenes JSON + keyframes ZIP (+ opsiyonel mp4)
Çıktı: Drive veya yerel PROJECTS_ROOT altında L2.5'in beklediği yapı.
"""
from __future__ import annotations

import re
import shutil
import zipfile
import pathlib
from typing import Optional


def _safe_project_name(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = name.strip(". ") or "project"
    return name[:120]


def materialize_export(
    dest: pathlib.Path,
    *,
    project: str,
    scenes_bytes: bytes,
    zip_bytes: bytes,
    video_bytes: Optional[bytes] = None,
    video_name: Optional[str] = None,
) -> dict:
    """
    dest/<project>/ altına:
      {project}_scenes_manual.json
      keyframes/...
      (opsiyonel) video
    ZIP içindeki keyframes/ ve keyframes_swapped/ açılır.
    """
    project = _safe_project_name(project)
    root = dest / project
    if root.exists():
        # scenes + keyframes üzerine yaz; progress/videoları silme
        pass
    root.mkdir(parents=True, exist_ok=True)

    scenes_path = root / f"{project}_scenes_manual.json"
    scenes_path.write_bytes(scenes_bytes)

    tmp_zip = root / "_ingest_keyframes.zip"
    tmp_zip.write_bytes(zip_bytes)
    extracted = {"keyframes": 0, "other": 0}
    try:
        with zipfile.ZipFile(tmp_zip, "r") as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = info.filename.replace("\\", "/")
                if name.startswith("__MACOSX") or name.endswith(".DS_Store"):
                    continue
                # ZIP bazen keyframes/... veya düz scene_001/... olabilir
                out_rel = name
                if not (
                    name.startswith("keyframes/")
                    or name.startswith("keyframes_swapped/")
                ):
                    # gömülü scenes json atla (ayrı dosya yazıyoruz)
                    if name.endswith(".json") and "scenes" in name.lower():
                        continue
                    if "/" not in name and name.endswith(".jpg"):
                        continue
                target = root / out_rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                if out_rel.startswith("keyframes/"):
                    extracted["keyframes"] += 1
                else:
                    extracted["other"] += 1
    finally:
        try:
            tmp_zip.unlink()
        except OSError:
            pass

    video_written = None
    if video_bytes:
        vname = video_name or f"{project}.mp4"
        vname = pathlib.Path(vname).name
        if not vname.lower().endswith((".mp4", ".mov", ".webm", ".mkv")):
            vname = f"{project}.mp4"
        vpath = root / vname
        vpath.write_bytes(video_bytes)
        video_written = vname

    kf_ok = (root / "keyframes").is_dir() and any((root / "keyframes").rglob("*"))
    return {
        "project": project,
        "path": str(root),
        "scenes": scenes_path.name,
        "has_keyframes": kf_ok,
        "extracted": extracted,
        "video": video_written,
    }
