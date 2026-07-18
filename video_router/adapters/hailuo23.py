"""
hailuo23.py — Hailuo 2.3 adaptoru (HAZIR — model 23217)
=======================================================
Hailuo pipeline: start_only sahneler buraya gelir.
Ortak akis _hailuo.submit (2.0 ile ayni; TEK fark model ID).

Model ID: 23217 (2.0 = 23210). Diger parametreler 2.0 ile ayni: resolution 1080,
duration 6, projectID klasorden. Token/cookie/project: VIDEO klasorunde.

referenceMode notu: hl_generate_video start_only'de "start-frame" + tek dosya (frameType 0)
gonderir. Curl'de "start-end-frames" + tek dosya goruldu (panel state'i olabilir).
ONCE "start-frame" ile denenir; 2.3 reddederse curl'deki start-end-frames taklit edilecek.
Poll 2.0 ile ayni (vid_id bazli my-work-detail, proje bagimsiz, watermarksiz).
"""

from .. import core
from . import _hailuo

MODEL_ID = "23217"


def _generate(job: core.Job):
    return _hailuo.submit(job, model_id=MODEL_ID, tag="Hailuo 2.3")


SPEC = core.register(core.AdapterSpec(
    key="hailuo2.3",
    provider="hailuo",
    model_tag="hailuo23",
    modes={"start_only"},
    ready=True,
    generate=_generate,
    token_files=["hailuo_token.txt", "hailuo_cookie.txt", "hailuo_project.txt"],  # VIDEO klasorunde
    description="Hailuo 2.3 (start_only, model 23217) — HAZIR.",
))
