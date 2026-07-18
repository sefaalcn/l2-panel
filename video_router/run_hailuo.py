"""
run_hailuo.py — TAMAMEN Hailuo pipeline'i (giris noktasi)
=========================================================
Sahneleri router'a gore Hailuo 2.0 / 2.3'e dagitir (henuz placeholder).
Firefly pipeline'indan bagimsiz; ayni anda calisabilir.

Kullanim:
  python3 -m video_router.run_hailuo --path "/.../New Videos/<Video>"
  python3 -m video_router.run_hailuo --path "/.../<Video>" --variants v1 --dry-run
"""

from .cli import main

if __name__ == "__main__":
    main("hailuo")
