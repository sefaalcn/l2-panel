"""
_firefly3p.py — Firefly-3p ailesi ortak akisi (Ray3.14 / Kling / Runway)
=======================================================================
Bu modeller AYNI firefly-3p endpoint'ini, AYNI Firefly token'ini, ayni poll +
download akisini paylasir; SADECE payload (ve modele ozel arp/nonce) degisir.

Yeni bir 3p model eklemek icin adaptor sadece:
  1) build_payload(job, start_id) -> dict   (curl govdesinin sablonu)
  2) submit(job, payload, arp_file, nonce_file, tag) cagirir
Upload/headers/POST-retry/result-url/poll/download hepsi burada.

Header kurali: token firefly_token.txt (paylasilan); arp/nonce <model>_arp.txt /
<model>_nonce.txt VARSA onlar, yoksa firefly_arp/nonce (ff._base_headers fallback).
result URL: once x-override-status-link header'i, yoksa govde (esnek).
"""

import time
import json
import hashlib
import pathlib

import requests

from .. import core
import firefly_gen as ff


def stable_seed(job: core.Job) -> int:
    """(label, variant) -> STABIL seed (resume'da ayni, sahneler arasi farkli)."""
    h = hashlib.md5(f"{job.label}_{job.variant}".encode()).hexdigest()
    return int(h, 16) % 1_000_000


def headers(arp_file=None, nonce_file=None) -> dict:
    """Paylasilan Firefly auth + (varsa) modele ozel arp/nonce ile ez."""
    h = ff._base_headers()                 # firefly token + firefly arp/nonce + api-key + UA
    h["content-type"] = "application/json"
    if arp_file:
        v = core.read_optional(arp_file)
        if v:
            h["x-arp-session-id"] = v
    if nonce_file:
        v = core.read_optional(nonce_file)
        if v:
            h["x-nonce"] = v
    return h


def extract_result_url(resp) -> str:
    """Once header (x-override-status-link, Ray3.14/Kling gibi), yoksa govde."""
    href = resp.headers.get("x-override-status-link")
    if href:
        return href.rstrip("/")
    try:
        data = resp.json()
    except ValueError:
        data = {}
    return (data.get("links", {}).get("result", {}).get("href")
            or data.get("statusUrl") or data.get("resultUrl") or data.get("href") or "")


def _poll_and_download(job: core.Job, href: str, tag: str) -> pathlib.Path:
    """result URL -> poll -> indir. Asamalar etiketli, derin retry (video kaybini onle)."""
    url, vid = core.retry(lambda: ff.poll_result(href), label="firefly-poll",
                          attempts=5, backoffs=(5, 15, 30, 45, 60))
    ff.OUTPUT_DIR = job.out_path.parent
    ff.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = core.retry(lambda: ff.download_video(url, job.out_path.stem), label="firefly-download",
                      attempts=5, backoffs=(5, 15, 30, 45, 60))
    print(f"\n>> BITTI ({tag}). Video: {path}")
    return pathlib.Path(path)


def submit(job: core.Job, payload: dict, arp_file, nonce_file, tag: str) -> pathlib.Path:
    """POST-retry -> result URL -> poll -> OTOMATIK indir. Inen dosyanin yolunu don."""
    # --- RESUME: result URL (href) zaten kaydedilmis -> POST YOK, sadece poll+download ---
    # DIKKAT: Firefly href bir IS-DURUMU URL'si, suresi DOLABILIR (Hailuo vid_id gibi kalici degil).
    # Olu href'i 30dk poll'lama; gecersizse (404/expired/FAILED) TEMIZ mesajla yeniden uretime dus.
    if job.resume_vid_id:
        print(f">> [RESUME] {tag}: result URL ile poll+download (POST YOK)")
        try:
            return _poll_and_download(job, job.resume_vid_id, tag)
        except SystemExit:
            raise                          # token/auth (401/403) -> yukari, yeniden uretme
        except Exception as e:
            print(f"   [RESUME] result URL olu/gecersiz ({type(e).__name__}) -> YENIDEN URETIME dusuluyor")
            # asagidaki normal POST akisina dus (yeni href uretilecek, on_submit onu kaydeder)

    hd = headers(arp_file, nonce_file)

    print(f">> [1] generate ({tag} / firefly-3p async)...")
    resp = None
    for attempt in range(1, 6):
        # requests.post'u retry ile sar: gecici AG hatasi (SSL/ConnectionError/Timeout) tekrar dener.
        # 5xx durum kodu asagidaki dongu tarafindan zaten ele aliniyor (govde/header kontrolu icin).
        resp = core.retry(
            lambda: requests.post(ff.GENERATE_3P_ASYNC, headers=hd, json=payload, timeout=90),
            label="generate-post")
        print(f"   deneme {attempt}: HTTP {resp.status_code}")
        if resp.status_code == 401:
            raise SystemExit("!! 401 = token suresi dolmus.")
        if resp.status_code in (408, 425, 429, 500, 502, 503, 504):
            wait = 8 * attempt
            print(f"   >> gecici sunucu hatasi. {wait}s bekleyip tekrar...")
            time.sleep(wait)
            continue
        break

    if resp.status_code >= 400:
        print("   --- SUNUCU HATA (ham) ---")
        print(resp.text[:2000])
        print("   >> gonderilen payload:")
        print(json.dumps(payload, indent=2, ensure_ascii=False)[:1500])
        raise SystemExit(f"!! {tag} generate-async HTTP {resp.status_code}")

    href = extract_result_url(resp)
    if not href:
        print("   Response headers:")
        for k, v in resp.headers.items():
            print(f"     {k}: {v}")
        raise SystemExit(f"!! {tag} result URL bulunamadi (header/govde).")
    print(f"   result URL: {href}")
    if job.on_submit:                  # SUBMIT OK -> result URL'i (vid_id) HEMEN kaydet (poll olurse kurtar)
        job.on_submit(href)

    # poll + download: gecici hatada derin retry (generate TEKRARLANMAZ -> kota israfi yok).
    return _poll_and_download(job, href, tag)
