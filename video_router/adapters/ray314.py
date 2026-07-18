"""
ray314.py — Ray3.14 adaptoru (HAZIR)
====================================
Firefly-3p ailesi (Kling/Runway ile ortak akis: _firefly3p.submit + retry).
Onceden ff.run'u monolitik cagiriyordu; simdi payload'i BIREBIR (firefly_gen._generate_ray314
ile ayni) kurup submit'e veriyor -> poll/download RETRY'li olur, generate TEKRARLANMAZ.

Kullanim:
  both     -> start (promptReference 1) + end (promptReference 2)   [ray314.py]
  end_only -> sadece end (promptReference 2)                        [ray314_end.py bu _generate'i cagirir]
firefly_gen.py DEGISTIRILMEDEN kutuphane olarak kullanilir (upload/poll/download).
"""

import pathlib

from .. import core
from . import _firefly3p as f3p
import firefly_gen as ff

# firefly_gen.run()'in Ray3.14 varsayilanlari (davranis birebir korunur)
NEGATIVE_PROMPT = "cartoon, vector art, & bad aesthetics & poor aesthetic"
MODE            = "flex_2"
ASPECT_RATIO    = "16:9"

# Cozunurluk: Ray3.14 720p promo'da SINIRSIZ, 1080p KREDILI (kredi bitince 1080p -> 403 access_error).
# VARSAYILAN 720p (guvenli). --resolution 1080p ezer (kredi varken). 1080p payload'i eski curl'le
# BIREBIR; 720p payload'i kullanicinin bugunku calisan F12 curl'unden (yalniz size + resolution degisir).
DEFAULT_RESOLUTION = "720p"
_SIZES = {"720p": (1280, 720), "1080p": (1920, 1080)}


def build_payload(job: core.Job, start_id, end_id) -> dict:
    res = job.resolution if job.resolution in _SIZES else DEFAULT_RESOLUTION
    width, height = _SIZES[res]
    reference_blobs = []
    if start_id:
        reference_blobs.append({"id": start_id, "usage": "general", "promptReference": 1})
    if end_id:
        reference_blobs.append({"id": end_id, "usage": "general", "promptReference": 2})
    payload = {
        "modelId": "luma",
        "modelVersion": "3.14-ray",
        "size": {"width": width, "height": height},
        "mode": MODE,
        "prompt": job.prompt,
        "negativePrompt": NEGATIVE_PROMPT,
        "duration": job.duration,
        "generationMetadata": {"module": "text2video", "submodule": "ff-video-generate"},
        "modelSpecificPayload": {"resolution": res, "aspect_ratio": ASPECT_RATIO},
        "output": {"storeInputs": True},
    }
    if reference_blobs:
        payload["referenceBlobs"] = reference_blobs
    return payload


def generate(job: core.Job) -> pathlib.Path:
    """both (start+end) ve end_only (yalniz end) icin ortak. Upload retry'li."""
    start_id = core.retry(lambda: ff.upload_image(job.start_image), label="upload") if job.start_image else None
    end_id   = core.retry(lambda: ff.upload_image(job.end_image),   label="upload") if job.end_image else None
    payload = build_payload(job, start_id, end_id)
    # Ray3.14 firefly token/arp/nonce'u paylasir (kendi arp/nonce dosyasi yok -> None)
    return f3p.submit(job, payload, None, None, "Ray3.14")


SPEC = core.register(core.AdapterSpec(
    key="ray3.14",
    provider="firefly",
    model_tag="ray314",
    modes={"both"},
    ready=True,
    generate=generate,
    token_files=["firefly_token.txt", "firefly_arp.txt", "firefly_nonce.txt"],
    description="Luma Ray3.14 (both: start+end) — firefly-3p, retry'li, HAZIR.",
))
