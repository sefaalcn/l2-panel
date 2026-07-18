"""
run_firefly.py — TAMAMEN Firefly pipeline'i (giris noktasi)
===========================================================
Sahneleri router'a gore Ray3.14 / Kling / Runway'e dagitir.
Hailuo pipeline'indan bagimsiz; ayni anda calisabilir.

Kullanim:
  python3 -m video_router.run_firefly --path "/.../New Videos/<Video>"
  python3 -m video_router.run_firefly --path "/.../<Video>" --variants v1,v3 --scenes 1-5
  python3 -m video_router.run_firefly --path "/.../<Video>" --dry-run
"""

from .cli import main

if __name__ == "__main__":
    main("firefly")
