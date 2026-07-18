"""
hailuo20.py — Hailuo 2.0 adaptoru (HAZIR — model 23210)
=======================================================
Hailuo pipeline: both + end_only sahneler buraya gelir.
Ortak akis _hailuo.submit (hailuo_pipeline.py yeniden kullanilir; OSS upload + yy imza +
frame_mode + result-poll + OTOMATIK indirme).

Model ID: 23210 (mevcut hailuo_pipeline'in sabiti). "2.0" adi teyit edilmedi ama
video inip kaliteliyse sorun degil (karar B). Hata/kotu kalite olursa 2.0 curl'u yakalanir.
Token/cookie/project: VIDEO klasorunde (hailuo_token.txt / hailuo_cookie.txt / hailuo_project.txt).
"""

from .. import core
from . import _hailuo

MODEL_ID = "23210"


def _generate(job: core.Job):
    return _hailuo.submit(job, model_id=MODEL_ID, tag="Hailuo 2.0")


SPEC = core.register(core.AdapterSpec(
    key="hailuo2.0",
    provider="hailuo",
    model_tag="hailuo20",
    modes={"both", "end_only"},
    ready=True,
    generate=_generate,
    token_files=["hailuo_token.txt", "hailuo_cookie.txt", "hailuo_project.txt"],  # VIDEO klasorunde
    description="Hailuo 2.0 (both + end_only, model 23210) — HAZIR.",
))
