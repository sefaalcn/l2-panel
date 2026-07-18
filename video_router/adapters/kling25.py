"""
kling25.py — Kling 2.5 adaptoru (HAZIR)
=======================================
Firefly start_only, CIFT ordinal sahneler buraya gelir.
Firefly-3p ailesi (Ray3.14/Runway ile ortak akis: _firefly3p.submit).

Kling payload ozellikleri (F12 curl, GERCEK URETIMDE dogrulandi):
  modelId="kling", modelVersion="kling_v2_5_turbo_pro_i2v"
  size 1920x1080, duration=5, generateAudio=false
  referenceBlobs: {id, usage:"frame", order:1}   (start_only -> tek blob)
  generationMetadata.module="image2video"
  negative_prompt modelSpecificPayload ICINDE (top-level negativePrompt yok), mode yok
Auth: token firefly_token.txt (paylasilan); arp/nonce kling_arp.txt / kling_nonce.txt.
"""

import pathlib

from .. import core
from . import _firefly3p as f3p
import firefly_gen as ff

MODEL_ID        = "kling"
MODEL_VERSION   = "kling_v2_5_turbo_pro_i2v"
NEGATIVE_PROMPT = "blur, distort, and low quality"
WIDTH, HEIGHT   = 1920, 1080
ASPECT_RATIO    = "16:9"
DURATION        = 5


def build_payload(job: core.Job, start_id: str) -> dict:
    return {
        "modelId": MODEL_ID,
        "modelVersion": MODEL_VERSION,
        "size": {"width": WIDTH, "height": HEIGHT},
        "seeds": [f3p.stable_seed(job)],
        "referenceBlobs": [{"id": start_id, "usage": "frame", "order": 1}],
        "prompt": job.prompt,
        "duration": (job.duration or DURATION),
        "generateAudio": False,
        "generationMetadata": {"module": "image2video", "submodule": "ff-video-generate"},
        "modelSpecificPayload": {"aspect_ratio": ASPECT_RATIO, "negative_prompt": NEGATIVE_PROMPT},
        "output": {"storeInputs": True},
    }


def _generate(job: core.Job) -> pathlib.Path:
    start_id = core.retry(lambda: ff.upload_image(job.start_image), label="upload")  # start_only -> tek frame
    payload = build_payload(job, start_id)
    return f3p.submit(job, payload, "kling_arp.txt", "kling_nonce.txt", "Kling 2.5")


SPEC = core.register(core.AdapterSpec(
    key="kling2.5",
    provider="firefly",
    model_tag="kling",
    modes={"start_only"},
    ready=True,
    generate=_generate,
    token_files=["firefly_token.txt (paylasilan)", "kling_arp.txt (ops)", "kling_nonce.txt (ops)"],
    description="Kling 2.5 turbo pro i2v (start_only, cift ordinal) — firefly-3p, HAZIR.",
))
