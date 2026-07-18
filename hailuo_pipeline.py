#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hailuo I2V Pipeline (3 Varyant) — genel (her video için --path ile)
===================================================================

KULLANIM:
  python3 hailuo_pipeline.py hailuo   --path "/Users/onur/Desktop/New Videos/Too_Hot"
  python3 hailuo_pipeline.py hailuo   --path "/.../Too_Hot" --scenes 1-5
  python3 hailuo_pipeline.py hailuo   --path "/.../Too_Hot" --swapped
  python3 hailuo_pipeline.py hailuo   --path "/.../Too_Hot" --optimizer off   # verbatim (V1/V2/V3 aynen)
  python3 hailuo_pipeline.py status   --path "/.../Too_Hot"
  python3 hailuo_pipeline.py download --path "/.../Too_Hot"

PROJE ID (her video için AYRI):
  hailuoai.video panelinde bu video için açtığın projenin ID'si gerekir.
  --project XXXXX ile ver, ya da <proje>/hailuo_project.txt içine yaz; yoksa sorar+kaydeder.

TOKEN / COOKIE:
  <proje>/hailuo_token.txt  ← hailuoai.video > F12 > Network > istek > Request Headers > 'token'
  <proje>/hailuo_cookie.txt ← aynı yerden Cookie header değeri

Her sahne için v1, v2, v3 = 3 ayrı video. Keyframe kaynağı VARSAYILAN keyframes/ (orijinal);
--swapped verilirse keyframes_swapped/. frame_mode start_only/end_only sahne bazında uygulanır.
Optimizer VARSAYILAN AÇIK (useOriginPrompt=False) — gemini_direct optimizer-dostu promptlarıyla uyumlu.
"""

import os, sys, json, time, uuid, re, subprocess, shutil, requests, base64, hashlib, random
from pathlib import Path
from datetime import datetime
from typing import Optional

# ─── YAPILANDIRMA (──path ile doldurulur — setup_paths) ──────────────────────

# Bu yollar setup_paths() içinde --path'ten türetilir (master.py her zaman --path geçirir).
BASE_DIR      = None
OUTPUT_DIR    = None
HAILUO_DIR    = None
PROGRESS_FILE = None
PROMPTS_JSON  = None
PROJECT_NAME  = ""

# Keyframe kaynagi — VARSAYILAN orijinal kareler; --swapped ile swaplı klasöre geçer
USE_SWAPPED = False
KEYFRAMES_SWAPPED_DIR = None
KEYFRAMES_ORIG_DIR    = None

# ── Hailuo sabit degerler (kalıcı — tüm projelerde aynı) ──
HAILUO_BASE    = "https://hailuoai.video"
HAILUO_MODEL   = "23210"
HAILUO_PROJECT = ""          # HER VİDEO İÇİN AYRI — <base>/hailuo_project.txt veya --project'ten gelir

HAILUO_UUID      = "004e1a0a-0ea8-41c2-8921-102eb9898e3b"
HAILUO_DEVICE_ID = "399744959216705542"

# Optimizer: gemini_direct promptları optimizer-DOSTU yazıldığı için VARSAYILAN optimizer AÇIK
#   USE_ORIGIN_PROMPT = False → optimizer AÇIK (Hailuo promptu kendi optimize eder)  ← gemini_direct ile uyumlu
#   USE_ORIGIN_PROMPT = True  → optimizer KAPALI (V1/V2/V3 AYNEN kullanılır)         ← eski verbatim promptlar için
USE_ORIGIN_PROMPT = False

DEFAULT_SCENES = None        # None → prompt JSON'undaki tüm sahneler

VARIANTS = ["v1", "v2", "v3"]  # 3 varyant (gemini_direct / Claude prompt gen)


def setup_paths(path: str, project_id: str = None):
    """--path'ten tüm yolları türet; Hailuo proje ID'sini dosya/argüman/sorudan al."""
    global BASE_DIR, OUTPUT_DIR, HAILUO_DIR, PROGRESS_FILE, PROMPTS_JSON, PROJECT_NAME
    global KEYFRAMES_SWAPPED_DIR, KEYFRAMES_ORIG_DIR, HAILUO_PROJECT
    BASE_DIR = Path(path).expanduser()
    if not BASE_DIR.exists():
        log(f"❌ Klasör yok: {BASE_DIR}"); sys.exit(1)
    PROJECT_NAME = BASE_DIR.name
    OUTPUT_DIR    = BASE_DIR / f"{PROJECT_NAME}_output"
    HAILUO_DIR    = BASE_DIR / "hailuo prompt"          # üretilen videolar buraya iner
    PROGRESS_FILE = BASE_DIR / "pipeline_progress.json"
    PROMPTS_JSON  = OUTPUT_DIR / "hailuo_prompts_claude.json"
    KEYFRAMES_SWAPPED_DIR = BASE_DIR / "keyframes_swapped"
    KEYFRAMES_ORIG_DIR    = BASE_DIR / "keyframes"

    # Hailuo proje ID'si — SIRA: HAILUO_PROJECT_FILE env-dosya (.l2_project, L2.5 override) > --project
    # (ESKI: yaz+kullan) > hailuo_project.txt > sor. env yoksa BIREBIR eski davranis (regresyon korunur).
    pf = BASE_DIR / "hailuo_project.txt"
    _env_pf = os.environ.get("HAILUO_PROJECT_FILE", "").strip()
    if _env_pf and Path(_env_pf).exists():
        HAILUO_PROJECT = Path(_env_pf).read_text(encoding="utf-8").strip()   # L2.5 override (env-dosya)
    elif project_id:
        HAILUO_PROJECT = project_id.strip()
        pf.write_text(HAILUO_PROJECT, encoding="utf-8")                      # ESKI: --project yaz+kullan (regresyon)
    elif pf.exists():
        HAILUO_PROJECT = pf.read_text(encoding="utf-8").strip()
    else:
        log("🆔 Bu video için Hailuo PROJE ID'si gerekli (hailuoai.video panelinde bu video için açtığın proje).")
        log("   URL'de: .../create/image-to-video?projectId=XXXXX  → XXXXX değeri")
        try:
            HAILUO_PROJECT = input("   Proje ID: ").strip()
        except EOFError:
            HAILUO_PROJECT = ""
        if not HAILUO_PROJECT:
            log("❌ Proje ID girilmedi."); sys.exit(1)
        pf.write_text(HAILUO_PROJECT, encoding="utf-8")
    log(f"📂 Proje: {PROJECT_NAME} | Hailuo proje ID: {HAILUO_PROJECT}")

# ─── YARDIMCILAR ──────────────────────────────────────────────

def log(msg): print(msg, flush=True)

def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {}

def save_progress(data: dict):
    PROGRESS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))

def parse_scenes_arg(arg: str) -> list:
    scenes = []
    for part in arg.split(","):
        part = part.strip()
        if "-" in part:
            s, e = part.split("-"); scenes += range(int(s), int(e)+1)
        else:
            scenes.append(int(part))
    return sorted(set(scenes))

# ─── FRAME BULMA (swapped oncelikli, orijinal fallback) ──────

def find_frame(label: str, frame_type: str) -> Path | None:
    """Keyframe'i bul — kaynak USE_SWAPPED bayragina gore secilir."""
    if USE_SWAPPED:
        dirs = (KEYFRAMES_SWAPPED_DIR, KEYFRAMES_ORIG_DIR)   # swapli oncelik, orijinal fallback
    else:
        dirs = (KEYFRAMES_ORIG_DIR,)                          # SADECE orijinal (yanlislikla swapli gitmesin)
    for d in dirs:
        for ext in (".jpg", ".png"):
            p = d / label / f"frame_{frame_type}{ext}"
            if p.exists():
                return p
    return None

# ─── TOKEN / COOKIE ───────────────────────────────────────────

def _cred_candidates(env_var: str, default_name: str) -> list:
    """env_var (HAILUO_TOKEN_FILE / HAILUO_COOKIE_FILE) SET'liyse ONCE onu; sonra BASE_DIR + Desktop varsayilani.
    L2.5 wrapper token'i .l2_token.txt'ye yazip env'le isaret eder -> gercek hailuo_token.txt KIRLENMEZ.
    env YOKSA: birebir eski davranis (regresyon — mevcut kosular etkilenmez)."""
    cands = []
    ep = os.environ.get(env_var, "").strip()
    if ep:
        cands.append(Path(ep))
    cands += [BASE_DIR / default_name, Path.home() / "Desktop" / default_name]
    return cands


def get_hailuo_token() -> str:
    candidates = _cred_candidates("HAILUO_TOKEN_FILE", "hailuo_token.txt")
    for tf in candidates:
        if tf.exists():
            t = tf.read_text().strip()
            try:
                payload = t.split(".")[1] + "=="
                data = json.loads(base64.b64decode(payload))
                remaining = data.get("exp", 0) - time.time()
                if remaining < 300:
                    log(f"  ⚠ Token suresi dolmak uzere ({remaining:.0f}s)!")
                else:
                    log(f"  Token gecerli ({remaining/3600:.1f}h kaldi)")
            except Exception:
                pass
            return t
    sys.exit(
        "hailuo_token.txt bulunamadi!\n"
        f"  Su konuma koy: {BASE_DIR / 'hailuo_token.txt'}\n"
        "  hailuoai.video > F12 > Network > istek > Request Headers > 'token'"
    )

def _get_cookies() -> str:
    for cf in _cred_candidates("HAILUO_COOKIE_FILE", "hailuo_cookie.txt"):
        if cf.exists():
            log(f"  Cookie: {cf.name}")
            return cf.read_text().strip()
    log("  hailuo_cookie.txt bulunamadi")
    return ""


def _read_token_file() -> str:
    for tf in _cred_candidates("HAILUO_TOKEN_FILE", "hailuo_token.txt"):
        if tf.exists():
            return tf.read_text().strip()
    return ""


def _token_exp_remaining(t: str):
    """JWT 'exp' kalan saniye (yerel, hızlı ipucu). Çözülemezse None."""
    try:
        payload = t.split(".")[1]
        payload += "=" * (-len(payload) % 4)        # base64 padding
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("exp", 0) - time.time()
    except Exception:
        return None


def _token_live_ok(token: str) -> bool:
    """Canlı kontrol: heartbeat 200 (>=0) ise token GEÇERLİ. Tek geçici hataya retry."""
    if hl_heartbeat(token) >= 0:
        return True
    time.sleep(2)                                    # geçici ağ hatası olabilir — bir kez daha dene
    return hl_heartbeat(token) >= 0


def ensure_token() -> str:
    """ÜRETİMDEN ÖNCE token/cookie tazeliğini kontrol et.
    - Mevcut dosyaları OTOMATİK kullanır (her seferinde sormaz).
    - Geçerliyse 'güncel' deyip devam eder.
    - Geçersiz/süresi dolmuşsa SADECE o zaman yeni token (+cookie) ister, kaydeder, doğrular.
    """
    token = _read_token_file()
    if token:
        rem = _token_exp_remaining(token)
        if rem is not None:
            log(f"  🔑 JWT: {'süresi dolmuş' if rem <= 0 else f'{rem/3600:.1f}h kaldı'}")
        log("  🔎 Token canlı kontrol ediliyor...")
        if (rem is None or rem > 60) and _token_live_ok(token):
            log("  ✅ Token GÜNCEL — mevcut token/cookie kullanılıyor (yeniden istemedim).")
            return token
        log("  ⚠️ Mevcut token geçersiz/süresi dolmuş.")
    else:
        log("  ⚠️ hailuo_token.txt yok.")

    # Sadece BURADA yeni token iste (geçersizse)
    log("\n  🔁 Yeni token gerekli — hailuoai.video > F12 > Network > herhangi istek")
    log("     > Request Headers > 'token' değerini KOPYALA ve yapıştır:")
    try:
        new_t = input("  Yeni token: ").strip()
    except EOFError:
        new_t = ""
    if not new_t:
        sys.exit("❌ Token girilmedi — üretim durduruldu.")
    (BASE_DIR / "hailuo_token.txt").write_text(new_t, encoding="utf-8")

    log("  Cookie da değiştiyse yeni 'Cookie' header'ını yapıştır (DEĞİŞMEDİYSE boş bırak):")
    try:
        new_c = input("  Yeni cookie: ").strip()
    except EOFError:
        new_c = ""
    if new_c:
        (BASE_DIR / "hailuo_cookie.txt").write_text(new_c, encoding="utf-8")

    if _token_live_ok(new_t):
        log("  ✅ Yeni token GÜNCEL — devam ediliyor.")
        return new_t
    sys.exit("❌ Yeni token da geçersiz. F12'den doğru 'token' header'ını (ve gerekiyorsa cookie'yi) kopyaladığından emin ol.")

# ─── PROMPT LOADER ────────────────────────────────────────────

def load_prompts() -> dict:
    """hailuo_prompts_claude.json -> {scene_index: {v1, v2, v3, frame_mode}}"""
    if not PROMPTS_JSON.exists():
        log(f"  Prompt dosyasi bulunamadi: {PROMPTS_JSON}")
        return {}
    data = json.loads(PROMPTS_JSON.read_text())
    # Vercel wrapper format destegi
    if isinstance(data, dict) and "scenes" in data:
        data = data["scenes"]
    prompts = {}
    for p in data:
        idx = p.get("index")
        if idx:
            prompts[idx] = {
                "v1":         p.get("v1", ""),
                "v2":         p.get("v2", ""),
                "v3":         p.get("v3", ""),
                "frame_mode": p.get("frame_mode", "both"),
                "label":      p.get("label", f"scene_{idx:03d}"),
            }
    log(f"  {len(prompts)} sahne promptu yuklendi")
    return prompts

# ─── HAILUO API ───────────────────────────────────────────────

def hl_params(unix_ms: Optional[int] = None) -> dict:
    if unix_ms is None:
        unix_ms = int(time.time() * 1000)
    return {
        "device_platform": "web", "app_id": "3001", "version_code": "22203",
        "biz_id": "0", "unix": str(unix_ms), "lang": "en",
        "uuid": HAILUO_UUID, "device_id": HAILUO_DEVICE_ID,
        "os_name": "Mac", "browser_name": "firefox", "cpu_core_num": "14",
        "browser_language": "tr-TR", "browser_platform": "MacIntel",
        "screen_width": "2560", "screen_height": "1440",
    }

def _compute_yy(url_path: str, params: dict, body: dict, method: str = "POST") -> str:
    from urllib.parse import urlencode, quote
    query    = urlencode(list(params.items()))
    full_url = f"{url_path}?{query}"
    body_str = json.dumps(body, separators=(',', ':')) if method.lower() in ("post", "delete") else "{}"
    timestamp = params.get("unix", str(int(time.time() * 1000)))
    time_md5  = hashlib.md5(timestamp.encode()).hexdigest()
    enc_url   = quote(full_url, safe="-_.!~*'()")
    raw       = enc_url + "_" + body_str + time_md5 + "ooui"
    return hashlib.md5(raw.encode()).hexdigest()

def hl_headers(token: str, yy: str = "") -> dict:
    headers = {
        "User-Agent":     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0",
        "Accept":         "application/json, text/plain, */*",
        "Accept-Language":"tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type":   "application/json",
        "token":          token,
        "Origin":         "https://hailuoai.video",
        "Referer":        f"https://hailuoai.video/create/image-to-video?projectId={HAILUO_PROJECT}",
    }
    if yy:
        headers["yy"] = yy
    cookies = _get_cookies()
    if cookies:
        headers["Cookie"] = cookies
    return headers

def _hl_get_sts(token: str) -> dict:
    r = requests.get(
        f"{HAILUO_BASE}/v1/api/files/request_policy",
        params=hl_params(), headers=hl_headers(token), timeout=30,
    )
    r.raise_for_status()
    resp = r.json()
    data = resp.get("data", {})
    log(f"    STS keys: {list(data.keys())}")
    return data

def _add_noise(img_path: Path) -> Path:
    from PIL import Image
    import tempfile
    img    = Image.open(img_path).convert("RGB")
    # Max 1920px genislik
    w, h   = img.size
    if w > 1920:
        ratio = 1920 / w
        img = img.resize((1920, int(h * ratio)), Image.LANCZOS)
        log(f"    📐 Resize: {w}x{h} → {img.size[0]}x{img.size[1]}")
    pixels = img.load()
    w, h   = img.size
    for _ in range(max(50, (w * h) // 200)):
        x, y    = random.randint(0, w-1), random.randint(0, h-1)
        r, g, b = pixels[x, y]
        pixels[x, y] = (
            max(0, min(255, r + random.randint(-3, 3))),
            max(0, min(255, g + random.randint(-3, 3))),
            max(0, min(255, b + random.randint(-3, 3))),
        )
    tmp = Path(tempfile.mktemp(suffix=".jpg"))
    img.save(tmp, "JPEG", quality=95)
    return tmp

def _reencode_jpeg(img_path: Path) -> Path:
    from PIL import Image
    import tempfile
    img = Image.open(img_path).convert("RGB")
    # Max 1920px genislik — Hailuo 1080P uretiyor, daha buyuk gereksiz
    w, h = img.size
    if w > 1920:
        ratio = 1920 / w
        img = img.resize((1920, int(h * ratio)), Image.LANCZOS)
        log(f"    📐 Resize: {w}x{h} → {img.size[0]}x{img.size[1]}")
    tmp = Path(tempfile.mktemp(suffix=".jpg"))
    img.save(tmp, "JPEG", quality=90)
    return tmp

def hl_upload_image(img_path: Path, token: str, add_noise: bool = False) -> tuple:
    tmp = _add_noise(img_path) if add_noise else _reencode_jpeg(img_path)
    try:
        return _hl_upload_impl(tmp, img_path.name, token)
    finally:
        tmp.unlink(missing_ok=True)

def _hl_upload_impl(upload_path: Path, original_name: str, token: str) -> tuple:
    import oss2
    file_uuid = str(uuid.uuid4())
    ext       = "jpeg"
    file_size = upload_path.stat().st_size

    sts         = _hl_get_sts(token)
    file_dir    = sts["dir"].rstrip("/")
    endpoint    = sts.get("endpoint", "oss-us-east-1.aliyuncs.com")
    bucket_name = sts.get("bucketName", "hailuo-video")
    file_name   = f"{file_uuid}.{ext}"
    oss_path    = f"{file_dir}/{file_name}"

    log(f"    OSS upload → {oss_path[-40:]}")
    auth   = oss2.StsAuth(sts["accessKeyId"], sts["accessKeySecret"], sts["securityToken"])
    bucket = oss2.Bucket(auth, f"https://{endpoint}", bucket_name, is_cname=False)
    bucket.put_object_from_file(oss_path, str(upload_path))
    log(f"    OSS OK")

    cdn_url = f"https://cdn.hailuoai.video/{oss_path}"
    r = requests.post(
        f"{HAILUO_BASE}/v1/api/files/policy_callback",
        params=hl_params(),
        headers=hl_headers(token),
        json={
            "fileName":       file_name,
            "originFileName": original_name,
            "dir":            file_dir,
            "endpoint":       endpoint,
            "bucketName":     bucket_name,
            "size":           str(file_size),
            "mimeType":       ext,
            "fileScene":      10,
        },
        timeout=30,
    )
    if r.status_code in (401, 403):
        raise RuntimeError("Hailuo token suresi dolmus — hailuo_token.txt guncelle")
    if r.status_code != 200:
        raise RuntimeError(f"policy_callback {r.status_code}: {r.text[:300]}")

    data    = r.json().get("data", {})
    file_id = data.get("fileID") or data.get("file_id")
    if not file_id:
        raise RuntimeError(f"fileID alinamadi: {r.json()}")
    oss_url = data.get("ossPath") or data.get("oss_path") or data.get("url")
    if oss_url:
        cdn_url = oss_url
    log(f"    fileID: {file_id}")
    return file_id, cdn_url, original_name

def _hailuo_api_call(path: str, body: dict, token: str) -> dict:
    from urllib.parse import urlencode
    params   = hl_params()
    yy       = _compute_yy(path, params, body)
    url      = f"{HAILUO_BASE}{path}?{urlencode(list(params.items()))}"
    body_str = json.dumps(body, separators=(',', ':'))
    headers  = hl_headers(token, yy)
    r = requests.post(url, data=body_str, headers=headers, timeout=60)
    if r.status_code != 200:
        log(f"    API {r.status_code}: {r.text[:500]}")
    r.raise_for_status()
    return r.json()


def hl_heartbeat(token: str) -> int:
    """Tarayicinin yaptigi gibi processing endpoint'ini cagir — kuyruk sayisini dondurur."""
    try:
        from urllib.parse import urlencode
        path = "/api/feed/creation/my/processing"
        body = {
            "batchInfoList": [],
            "type": 1,
            "projectID": HAILUO_PROJECT,
        }
        params = hl_params()
        yy = _compute_yy(path, params, body)
        url = f"{HAILUO_BASE}{path}?{urlencode(list(params.items()))}"
        headers = hl_headers(token, yy)
        r = requests.post(url, data=json.dumps(body, separators=(',', ':')),
                          headers=headers, timeout=15)
        if r.status_code == 200:
            data = r.json().get("data", {})
            processing = data.get("onProcessingVideoNum", 0)
            log(f"    💓 Heartbeat OK — kuyrukta {processing} video")
            return processing
        else:
            log(f"    💓 Heartbeat {r.status_code}")
            return -1
    except Exception as e:
        log(f"    💓 Heartbeat hatasi (onemli degil): {e}")
        return -1


MAX_QUEUE = 4  # Kuyrukta max bu kadar video olsun

def wait_for_queue(token: str, label: str = ""):
    """Kuyruk MAX_QUEUE'nun altina dusene kadar bekle."""
    while True:
        count = hl_heartbeat(token)
        if count < 0:
            # Heartbeat hatasi — 30s bekle tekrar dene
            time.sleep(30)
            continue
        if count < MAX_QUEUE:
            if label:
                log(f"    ✅ Kuyruk musait ({count}/{MAX_QUEUE}) — {label} gonderiliyor")
            return count
        log(f"    ⏳ Kuyruk dolu ({count}/{MAX_QUEUE}) — 30s bekleniyor...")
        time.sleep(30)

def hl_generate_video(
    first_id, first_url, first_name,
    last_id, last_url, last_name,
    prompt: str, token: str,
    frame_mode: str = "both",
    duration: int = 6,
    resolution: str = "1080",     # OLCULDU: 10sn ancak "768" (720p) ile kabul; 1080+10 -> 2400001
    use_origin_prompt: bool = None,  # None=modul varsayilani (USE_ORIGIN_PROMPT). True=verbatim, False=optimize
) -> str:
    if frame_mode == "both":
        file_list = [
            {"frameType": 0, "id": first_id, "name": first_name,
             "type": "jpeg", "characterUrl": "", "url": first_url.split("?")[0]},
            {"frameType": 1, "id": last_id, "name": last_name,
             "type": "jpeg", "characterUrl": "", "url": last_url.split("?")[0]},
        ]
        reference_mode = "start-end-frames"
    elif frame_mode == "end_only":
        # end_only: GERCEK end-frame — frameType:1 (end slot) + start-end-frames (start YOK).
        # Hailuo videoyu bu kareye VARACAK sekilde uretir. Ayri script + MSE ile dogrulandi:
        # frame_last <-> video SON kare MSE 5.6 (ILK kare 606.8) => kare SONDA. (Eski hali frameType:0
        # + start-frame idi -> kareyi BASLANGIC sanip ileri uretiyordu; MSE 4.3 ile bug kanitlandi.)
        file_list = [
            {"frameType": 1, "id": last_id, "name": last_name,
             "type": "jpeg", "characterUrl": "", "url": last_url.split("?")[0]},
        ]
        reference_mode = "start-end-frames"
    else:
        # start_only veya fallback
        file_list = [
            {"frameType": 0, "id": first_id, "name": first_name,
             "type": "jpeg", "characterUrl": "", "url": first_url.split("?")[0]},
        ]
        reference_mode = "start-frame"

    prompt_len    = len(prompt)
    prompt_struct = json.dumps({
        "value": [{"type": "paragraph", "children": [{"text": prompt}]}],
        "length": prompt_len, "plainLength": prompt_len, "rawLength": prompt_len,
    }, separators=(',', ':'))

    body = {
        "projectID": HAILUO_PROJECT,
        "quantity":  1,
        "parameter": {
            "modelID":         HAILUO_MODEL,
            "desc":            prompt,
            "fileList":        file_list,
            "referenceMode":   reference_mode,
            "useOriginPrompt": USE_ORIGIN_PROMPT if use_origin_prompt is None else use_origin_prompt,    # False=optimizer AÇIK / True=verbatim
            "resolution":      resolution,
            "duration":        duration,
            "aspectRatio":     "",
        },
        "videoExtra": {"promptStruct": prompt_struct},
    }

    resp = _hailuo_api_call("/v2/api/multimodal/generate/video", body, token)
    log(f"    API: {json.dumps(resp, ensure_ascii=False)[:300]}")

    status_code = (resp.get("statusInfo") or {}).get("code", 0)
    if status_code != 0:
        raise RuntimeError(f"API error {status_code}: {(resp.get('statusInfo') or {}).get('message','')}")

    vid_id = ((resp.get("data") or {}).get("videoID") or
              (resp.get("data") or {}).get("video_id") or
              (resp.get("data") or {}).get("id") or
              resp.get("videoID") or resp.get("video_id"))
    if not vid_id:
        raise RuntimeError(f"video_id alinamadi: {resp}")
    return str(vid_id)

# ─── HAILUO URETIM ────────────────────────────────────────────

def step_hailuo(scenes_arg: list = None):
    token       = ensure_token()      # ÜRETİMDEN ÖNCE tazelik kontrolü (geçerliyse devam, değilse yeni ister)
    progress    = load_progress()
    all_prompts = load_prompts()

    if not all_prompts:
        sys.exit("Prompt dosyasi bulunamadi veya bos")

    if scenes_arg is None:
        scenes_arg = sorted(all_prompts.keys())   # JSON'daki tüm sahneler

    log("=" * 60)
    log(f"{PROJECT_NAME.upper()} — Hailuo I2V (3 Varyant)")
    log(f"Sahneler: {scenes_arg}")
    log(f"Proje   : {HAILUO_PROJECT}")
    log(f"Optimizer: {'AÇIK (useOriginPrompt=False)' if not USE_ORIGIN_PROMPT else 'KAPALI (verbatim)'}")
    log(f"Keyframe kaynagi: {'SWAPLI (keyframes_swapped/)' if USE_SWAPPED else 'ORIJINAL (keyframes/)'}")
    log("Sira: her sahne icin v1→v2→v3, sonra siradaki sahne")
    log(f"Varyant arasi: 120-180s + kuyruk kontrol | Sahne arasi: 160-400s + kuyruk kontrol")
    log(f"Kuyruk limiti: max {MAX_QUEUE} video, altina dusunce gonder")
    log("=" * 60)

    HAILUO_DIR.mkdir(parents=True, exist_ok=True)

    for scene_idx, scene_num in enumerate(scenes_arg):
        prog_key   = f"scene_{scene_num:03d}"
        existing   = progress.get(prog_key, {})
        scene_data = all_prompts.get(scene_num)

        if not scene_data:
            log(f"\nSahne {scene_num:03d}: prompt bulunamadi, atlaniyor")
            continue

        # Tum 3 varyant tamamlanmis mi?
        done = [v for v in VARIANTS
                if existing.get(v) and not str(existing.get(v,"")).startswith("error")]
        if len(done) == len(VARIANTS):
            log(f"\nSahne {scene_num:03d}: v1/v2/v3 tamamlanmis, atlaniyor")
            continue

        frame_mode = scene_data["frame_mode"]
        label      = scene_data["label"]
        log(f"\n{'='*60}")
        log(f"Sahne {scene_num:03d} ({scene_idx+1}/{len(scenes_arg)}) [{frame_mode}]")

        # Frame bul (swapped oncelikli)
        first_img = find_frame(label, "first")
        last_img  = find_frame(label, "last")

        # Frame source bilgisi
        if first_img and "swapped" in str(first_img):
            log(f"  Frame source: swapped")
        elif first_img:
            log(f"  Frame source: orijinal")

        # Frame mode'a gore kontrol
        if frame_mode == "end_only":
            if not last_img:
                log(f"  end_only ama last frame bulunamadi, atlaniyor")
                continue
            log(f"  Frame: last frame (end_only modu)")
        else:
            if not first_img:
                log(f"  first frame bulunamadi, atlaniyor")
                continue
            if frame_mode == "both" and not last_img:
                log(f"  last frame bulunamadi, start_only moduna geciliyor")
                frame_mode = "start_only"
            log(f"  Frame: {label}")

        try:
            if frame_mode == "end_only":
                # end_only: sadece last frame upload
                log(f"  Last frame upload (end_only)...")
                last_id, last_url, last_name = hl_upload_image(last_img, token)
                first_id, first_url, first_name = last_id, last_url, last_name
                time.sleep(4)
            else:
                log(f"  First frame upload...")
                first_id, first_url, first_name = hl_upload_image(first_img, token)
                time.sleep(4)
                if frame_mode == "both":
                    log(f"  Last frame upload...")
                    last_id, last_url, last_name = hl_upload_image(last_img, token, add_noise=True)
                    time.sleep(4)
                else:
                    last_id, last_url, last_name = first_id, first_url, first_name
        except Exception as e:
            log(f"  Upload hatasi: {e}")
            continue

        # Her varyant icin video uret — v1→v2→v3
        vid_ids = dict(existing)
        variants_done_this_scene = 0

        for variant in VARIANTS:
            if vid_ids.get(variant) and not str(vid_ids.get(variant,"")).startswith("error"):
                log(f"  {variant}: zaten var, atlaniyor")
                continue

            prompt = scene_data.get(variant, "")
            if not prompt or prompt == "not applicable":
                log(f"  {variant}: prompt bos/not applicable, atlaniyor")
                vid_ids[variant] = "skipped:not_applicable"
                continue
            # Kamera parantezini Hailuo panel formatina normalize et: "[Push in, Pan left]" -> "[Push in,Pan left]"
            prompt = re.sub(r'^\[([^\]]+)\]', lambda m: '[' + m.group(1).replace(', ', ',') + ']', prompt)

            # 1. Sabit bekleme (varyant arasi)
            if variants_done_this_scene > 0:
                wait = random.randint(120, 180)
                log(f"  {wait}s bekleniyor (varyant arasi)...")
                time.sleep(wait)
                # 2. Kuyruk kontrolu — 4ten azsa gonder, degilse 30s arayla bekle
                wait_for_queue(token, f"scene {scene_num:03d} {variant}")

            log(f"  {variant}: {prompt[:80]}...")

            for attempt in range(3):
                try:
                    vid_id = hl_generate_video(
                        first_id, first_url, first_name,
                        last_id,  last_url,  last_name,
                        prompt, token, frame_mode=frame_mode,
                    )
                    log(f"  {variant} vid_id: {vid_id}")
                    vid_ids[variant] = vid_id
                    variants_done_this_scene += 1
                    hl_heartbeat(token)  # Kuyrugu canli tut
                    break
                except RuntimeError as e:
                    if "2400001" in str(e):
                        log(f"  2400001 — 12dk bekleniyor (deneme {attempt+1}/3)...")
                        time.sleep(720)
                    else:
                        log(f"  {variant} HATA: {e}")
                        vid_ids[variant] = f"error:{e}"
                        break
                except Exception as e:
                    log(f"  {variant} HATA: {e}")
                    vid_ids[variant] = f"error:{e}"
                    break

        progress[prog_key] = vid_ids
        save_progress(progress)
        log(f"  Sahne {scene_num:03d} kaydedildi: {list(vid_ids.keys())}")

        # 1. Sabit bekleme (sahne gecisi)
        if scene_idx < len(scenes_arg) - 1:
            wait = random.randint(160, 400)
            log(f"\n{wait}s bekleniyor (sahne gecisi)...")
            time.sleep(wait)
            # 2. Kuyruk kontrolu — 4ten azsa gonder, degilse 30s arayla bekle
            wait_for_queue(token, f"scene {scenes_arg[scene_idx+1]:03d}")

    log("\nTum sahneler tamamlandi!")

# ─── STATUS ───────────────────────────────────────────────────

def step_status():
    progress = load_progress()
    log("=" * 60)
    log(f"{PROJECT_NAME.upper()} — PIPELINE DURUMU")
    log("=" * 60)
    scenes_iter = sorted(load_prompts().keys()) or sorted(
        int(k.split("_")[1]) for k in progress.keys() if k.startswith("scene_"))
    done = errors = skipped = pending = 0
    for scene_num in scenes_iter:
        prog_key = f"scene_{scene_num:03d}"
        v = progress.get(prog_key, {})
        if not isinstance(v, dict) or not v:
            pending += 1
            log(f"  {prog_key}: ⏳ bekliyor")
            continue
        ok  = sum(1 for val in v.values() if val and not str(val).startswith("error") and not str(val).startswith("skipped"))
        err = sum(1 for val in v.values() if str(val).startswith("error"))
        skp = sum(1 for val in v.values() if str(val).startswith("skipped"))
        done    += 1 if ok >= 1 else 0
        errors  += err
        skipped += skp
        status_icon = "✅" if ok == 3 else "🟡" if ok >= 1 else "❌" if err > 0 else "⏳"
        log(f"  {status_icon} {prog_key}: v1={str(v.get('v1','—'))[:20]}  v2={str(v.get('v2','—'))[:20]}  "
            f"v3={str(v.get('v3','—'))[:20]}")
    log(f"\nTamamlanan: {done} sahne | Bekleyen: {pending} | Hata: {errors} | Atlanan (n/a): {skipped}")

# ─── DOWNLOAD ─────────────────────────────────────────────────

def step_download(scenes_arg: list = None):
    if scenes_arg is None:
        scenes_arg = sorted(load_prompts().keys())

    log("=" * 60)
    log(f"{PROJECT_NAME.upper()} — DOWNLOAD: Hailuo videolari indiriliyor")
    log("=" * 60)

    token    = get_hailuo_token()
    progress = load_progress()
    HAILUO_DIR.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    not_ready  = 0

    for scene_num in scenes_arg:
        prog_key = f"scene_{scene_num:03d}"
        vid_ids  = progress.get(prog_key, {})
        if not isinstance(vid_ids, dict) or not vid_ids:
            continue

        scene_out = HAILUO_DIR / f"scene_{scene_num:03d}"
        scene_out.mkdir(parents=True, exist_ok=True)

        for variant, vid_id in vid_ids.items():
            if str(vid_id).startswith("error") or str(vid_id).startswith("skipped"):
                continue

            out_file = scene_out / f"{variant}.mp4"
            if out_file.exists():
                continue

            try:
                from urllib.parse import urlencode
                params = hl_params()
                url = (f"{HAILUO_BASE}/v1/api/multimodal/video/result?"
                       f"{urlencode(list(params.items()))}&videoID={vid_id}")
                r = requests.get(url, headers=hl_headers(token), timeout=30)
                r.raise_for_status()
                resp       = r.json()
                video_data = resp.get("data") or {}
                video_url  = video_data.get("videoURL") or video_data.get("video_url") or ""
                status     = video_data.get("status", "")

                if not video_url:
                    not_ready += 1
                    log(f"  {prog_key}/{variant}: henuz hazir degil (status={status})")
                    continue

                log(f"  {prog_key}/{variant} indiriliyor...")
                vr = requests.get(video_url, timeout=120)
                vr.raise_for_status()
                out_file.write_bytes(vr.content)
                downloaded += 1
                log(f"    {out_file.name} kaydedildi ({len(vr.content)//1024}KB)")
                time.sleep(1)

            except Exception as e:
                log(f"    Indirme hatasi: {e}")

    log(f"\nDownload tamamlandi! Indirilen: {downloaded} | Hazir degil: {not_ready}")

# ─── MAIN ─────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(0)

    cmd = args[0]

    # --path: proje klasörü (master.py her zaman geçirir). Yoksa içinde bulunulan klasör.
    path = None
    if "--path" in args:
        i = args.index("--path")
        if i + 1 < len(args):
            path = args[i+1]
    if not path:
        path = str(Path.cwd())

    # --project: Hailuo proje ID'si (yoksa hailuo_project.txt'ten veya sorulur)
    project_id = None
    if "--project" in args:
        i = args.index("--project")
        if i + 1 < len(args):
            project_id = args[i+1]

    setup_paths(path, project_id)

    # --optimizer open|off : useOriginPrompt kontrolü (varsayılan open = gemini_direct uyumlu)
    if "--optimizer" in args:
        global USE_ORIGIN_PROMPT
        i = args.index("--optimizer")
        if i + 1 < len(args):
            USE_ORIGIN_PROMPT = (args[i+1].strip().lower() in ("off", "kapali", "verbatim", "true"))

    # --swapped: keyframe kaynagini swapli klasore cevir
    if "--swapped" in args:
        global USE_SWAPPED
        USE_SWAPPED = True
        print("  [--swapped] Keyframe kaynagi: keyframes_swapped/")

    # --fresh: ayri progress + ayri cikti klasoru (eski videolara dokunmaz)
    if "--fresh" in args:
        global PROGRESS_FILE, HAILUO_DIR
        PROGRESS_FILE = BASE_DIR / "pipeline_progress_v2.json"
        HAILUO_DIR    = BASE_DIR / "hailuo prompt v2"
        print(f"  [--fresh] Progress: {PROGRESS_FILE.name} | Cikti: {HAILUO_DIR.name}")

    scenes_arg = None
    if "--scenes" in args:
        i = args.index("--scenes")
        if i + 1 < len(args):
            scenes_arg = parse_scenes_arg(args[i+1])

    if   cmd == "hailuo":   step_hailuo(scenes_arg)
    elif cmd == "status":   step_status()
    elif cmd == "download": step_download(scenes_arg)
    else:
        print(f"Bilinmeyen komut: {cmd}"); print(__doc__)

if __name__ == "__main__":
    main()
