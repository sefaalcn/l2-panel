"""
ray314_end.py — Firefly 'end_only' adaptoru (HAZIR)
===================================================
end_only: video verilen KARE'de (frame_last) BITMELI; baslangic serbest.
GERCEK URETIMDE DOGRULANDI (scene_031): frame_last -> promptReference 2 (bitis).
firefly_gen'de bu, start_image=None + end_image=frame_last demektir.

ray314.generate ile AYNI kod (firefly-3p ailesi, retry'li); tek fark: Job'da start yok,
sadece end -> build_payload yalniz promptReference 2 gonderir.
"""

from .. import core
from . import ray314   # ortak generate + build_payload


SPEC = core.register(core.AdapterSpec(
    key="ray3.14_end",
    provider="firefly",
    model_tag="ray314",
    modes={"end_only"},
    ready=True,
    generate=ray314.generate,   # ayni akis; Job'da end_image=frame_last, start_image=None
    token_files=["firefly_token.txt", "firefly_arp.txt", "firefly_nonce.txt"],
    description="Ray3.14 end_only (frame_last -> promptReference 2) — retry'li, HAZIR.",
))
