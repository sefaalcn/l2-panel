"""
router.py — (provider, frame_mode, ordinal) -> adaptor anahtari
===============================================================
Saf esleme + tek donusum kurali. Ureten kod yok; sadece HANGI modele gidecegi.

FIREFLY:
  both       -> ray3.14            (HAZIR)
  end_only   -> ray3.14_end        (PLACEHOLDER/park — tek-frame promptReference test edilmedi)
  start_only -> start_model'e gore:
                 "kling"     -> kling2.5   (VARSAYILAN, 1080p, guvenli)
                 "runway"    -> runway4.5   (720p)
                 "alternate" -> DONUSUMLU: cift ordinal -> kling2.5 , tek ordinal -> runway4.5

HAILUO:
  both       -> hailuo2.0          (placeholder)
  end_only   -> hailuo2.0          (placeholder)
  start_only -> hailuo2.3          (placeholder)   # start_model YOK SAYILIR (tek secenek)

'ordinal' = sahnenin, TAM sahne listesindeki start_only'lar arasindaki 0-tabanli sirasi.
Resume-guvenli: hangi sahnenin bittiginden bagimsiz, ayni sahne hep ayni modele gider.
'start_model' sadece firefly start_only icin anlamli.
"""


def route(provider: str, frame_mode: str, ordinal: int = 0, start_model: str = "kling") -> str:
    provider = provider.lower()
    mode = (frame_mode or "both").lower()

    if provider == "firefly":
        if mode == "both":
            return "ray3.14"
        if mode == "end_only":
            return "ray3.14_end"          # park
        if mode == "start_only":
            sm = (start_model or "kling").lower()
            if sm == "kling":
                return "kling2.5"
            if sm == "runway":
                return "runway4.5"
            if sm == "alternate":
                return "kling2.5" if ordinal % 2 == 0 else "runway4.5"
            raise ValueError(f"Bilinmeyen start_model: {start_model} (kling|runway|alternate)")

    elif provider == "hailuo":
        if mode in ("both", "end_only"):
            return "hailuo2.0"
        if mode == "start_only":
            return "hailuo2.3"

    raise ValueError(f"Yonlendirilemedi: provider={provider} frame_mode={mode}")
