"""
l2_panel/config.py — L2.5 panel yapılandırması (DEKLARATİF).
================================================================================
Yeni model / yeni kimlik alanı / yeni ayar = BURAYA satır. Panel kodu (app.py) DEĞİŞMEZ:
frontend GET /models'ten alanları+options'ı dinamik render eder, backend target'a göre yazar.

target: {"type":"file","name":"..."} -> proje klasöründe o dosyaya yaz (koşu sonrası SİL)
        {"type":"env","name":"..."}  -> subprocess env olarak geç

Deploy:
  L2_CODE_ROOT       — repo kökü (gemini_direct / video_router)
  L2_PROJECTS_ROOT   — yerel proje klasörleri (local runtime)
  L2_SCRATCH_ROOT    — worker indirilen projeler
  L2_DRIVE_ROOT_ID   — Google Drive kök klasör ID (projeler burada)
  L2_RUNTIME         — local | cloud  (yoksa: Drive ID varsa cloud)
"""
import os
import pathlib

_HERE = pathlib.Path(__file__).resolve().parent
CODE_ROOT = pathlib.Path(os.environ.get("L2_CODE_ROOT", str(_HERE.parent))).resolve()

# Proje kökü (elle konmuş / Drive'dan sync). OLD/ atlanır.
PROJECTS_ROOT = os.environ.get(
    "L2_PROJECTS_ROOT",
    str(CODE_ROOT / "projects"),
)

SCRATCH_ROOT = os.environ.get(
    "L2_SCRATCH_ROOT",
    str(CODE_ROOT / ".l2_scratch"),
)

DRIVE_ROOT_ID = (os.environ.get("L2_DRIVE_ROOT_ID") or "").strip()

_runtime_env = (os.environ.get("L2_RUNTIME") or "local").strip().lower()
if _runtime_env in ("local", "cloud"):
    RUNTIME = _runtime_env
else:
    RUNTIME = "local"

MODELS = {
    "hailuo": {
        "label": "Hailuo",
        "active": True,                       # şu an yalnız Hailuo aktif
        "provider": "hailuo",                 # run_hailuo
        "credentials": [
            {"key": "token",   "label": "Hailuo Token", "target": {"type": "file", "name": "hailuo_token.txt",   "env": "HAILUO_TOKEN_FILE"},   "secret": True,  "required": True},
            {"key": "cookie",  "label": "Cookie",       "target": {"type": "file", "name": "hailuo_cookie.txt",  "env": "HAILUO_COOKIE_FILE"},  "secret": True,  "required": True},
            {"key": "project", "label": "Proje ID",     "target": {"type": "file", "name": "hailuo_project.txt", "env": "HAILUO_PROJECT_FILE"}, "secret": False, "required": True},
        ],
        "options": [
            {"key": "prompt_optimizer", "label": "Prompt Optimizer", "type": "toggle", "default": True,
             "note": "Açık=optimize (mevcut). Kapalı=verbatim (--no-optimizer, useOriginPrompt=True)."},
        ],
    },
    "firefly": {
        "label": "Firefly (yakında)",
        "active": False,                      # kimlik/adaptör hazır, panel akışı sonra
        "provider": "firefly",
        "credentials": [
            {"key": "token", "label": "Firefly Token", "target": {"type": "file", "name": "firefly_token.txt"}, "secret": True, "required": True},
            {"key": "arp",   "label": "arp",           "target": {"type": "file", "name": "firefly_arp.txt"},   "secret": True, "required": False},
            {"key": "nonce", "label": "nonce",         "target": {"type": "file", "name": "firefly_nonce.txt"}, "secret": True, "required": False},
        ],
        "options": [],                        # Firefly'da optimizer yok
    },
}

# Sağlayıcıdan BAĞIMSIZ ortak env (opsiyonel). Panel maskeli alır, subprocess env'e koyar (dosyaya YAZMAZ).
COMMON_ENV = [
    {"key": "ANTHROPIC_API_KEY", "label": "Anthropic Key (S4 soften — opsiyonel)", "secret": True, "required": False},
    {"key": "GEMINI_API_KEY",    "label": "Gemini Key (prompt üretimi)",           "secret": True, "required": False},
]
