"""
runway45.py — Runway Gen-4.5 adaptoru (HAZIR)
=============================================
Firefly start_only, TEK ordinal sahneler buraya gelir.
Firefly-3p ailesi (Ray3.14/Kling ile ortak akis: _firefly3p.submit).

Runway payload ozellikleri (F12 curl). Kling'den FARKLAR:
  modelId="runway", modelVersion="gen4.5"
  size 1280x720 (Runway 720p; Kling/Ray 1080p'ydi)
  referenceBlobs: {id, usage:"general", promptReference:1}  (Ray3.14 tarzi; Kling'in frame/order DEGIL)
  negativePrompt payload KOKUNDE (Kling'de modelSpecificPayload icindeydi)
  duration=8 (Kling 5'ti), generationMetadata.module="text2video"
  generateAudio YOK, modelSpecificPayload YOK
Auth: token firefly_token.txt (paylasilan); arp/nonce runway_arp.txt / runway_nonce.txt.
"""

import pathlib

from .. import core
from . import _firefly3p as f3p
import firefly_gen as ff

MODEL_ID        = "runway"
MODEL_VERSION   = "gen4.5"
NEGATIVE_PROMPT = "cartoon, vector art, & bad aesthetics & poor aesthetic"
WIDTH, HEIGHT   = 1280, 720
DURATION        = 8      # Runway curl'unde 8; modele ozel (Kling 5, Ray 5)


def build_payload(job: core.Job, start_id: str) -> dict:
    return {
        "modelId": MODEL_ID,
        "modelVersion": MODEL_VERSION,
        "size": {"height": HEIGHT, "width": WIDTH},
        "seeds": [f3p.stable_seed(job)],
        "referenceBlobs": [{"id": start_id, "usage": "general", "promptReference": 1}],
        "prompt": job.prompt,
        "negativePrompt": NEGATIVE_PROMPT,     # KOKTE (Ray3.14 gibi)
        "duration": (job.duration or DURATION),
        "generationMetadata": {"module": "text2video", "submodule": "ff-video-generate"},
        "output": {"storeInputs": True},
    }


def _generate(job: core.Job) -> pathlib.Path:
    start_id = core.retry(lambda: ff.upload_image(job.start_image), label="upload")  # start_only -> tek frame
    payload = build_payload(job, start_id)
    return f3p.submit(job, payload, "runway_arp.txt", "runway_nonce.txt", "Runway 4.5")


SPEC = core.register(core.AdapterSpec(
    key="runway4.5",
    provider="firefly",
    model_tag="runway",
    modes={"start_only"},
    ready=True,
    generate=_generate,
    token_files=["firefly_token.txt (paylasilan)", "runway_arp.txt (ops)", "runway_nonce.txt (ops)"],
    description="Runway Gen-4.5 (start_only, tek ordinal) — firefly-3p 720p/8sn, HAZIR.",
))
