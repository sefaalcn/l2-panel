"""
firefly_gen.py — Adobe Firefly Video pipeline (v5: native + Ray3.14, upload+generate+poll+download)
==================================================================================================
Iki model destegi:
  * "firefly"  -> Adobe native model  (video-v1.ff.adobe.io/v2/videos/generate)
  * "ray3.14"  -> Luma Ray3.14 partner (firefly-3p.ff.adobe.io/v2/3p-videos/generate-async)

TAM AKIS:
  gorsel dosyasi -> upload (blob id) -> generate -> poll -> mp4 indir

Gerekli dosya (bu klasorde):
  firefly_token.txt  -> Bearer sonrasi token
Opsiyonel (Ray3.14 icin bazen gerekli):
  firefly_arp.txt    -> x-arp-session-id
  firefly_nonce.txt  -> x-nonce

Cikti: outputs/<isim>.mp4
Token ~24 saat gecerli. 401 gorursen firefly_token.txt'yi F12'den yenile.
"""

import json
import time
import pathlib
import mimetypes
import requests

# ---------------------------------------------------------------------------
# AYARLAR
# ---------------------------------------------------------------------------
HERE = pathlib.Path(__file__).parent

UPLOAD_URL        = "https://firefly-3p.ff.adobe.io/v2/storage/image"
GENERATE_NATIVE   = "https://video-v1.ff.adobe.io/v2/videos/generate"
GENERATE_3P_ASYNC = "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async"
API_KEY = "clio-playground-web"

TOKEN_FILE = HERE / "firefly_token.txt"
ARP_FILE   = HERE / "firefly_arp.txt"
NONCE_FILE = HERE / "firefly_nonce.txt"
OUTPUT_DIR = HERE / "outputs"

POLL_INTERVAL = 5
POLL_TIMEOUT  = 600


# ---------------------------------------------------------------------------
# YARDIMCILAR
# ---------------------------------------------------------------------------
def _read(path):
    if path.exists():
        txt = path.read_text(encoding="utf-8").strip()
        return txt or None
    return None


def load_token():
    token = _read(TOKEN_FILE)
    if not token:
        raise SystemExit(f"HATA: {TOKEN_FILE.name} bulunamadi/bos.")
    return token.replace("Bearer ", "").strip()


def _base_headers():
    h = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "authorization": f"Bearer {load_token()}",
        "origin": "https://firefly.adobe.com",
        "referer": "https://firefly.adobe.com/",
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/149.0.0.0 Safari/537.36"
        ),
        "x-api-key": API_KEY,
    }
    arp = _read(ARP_FILE)
    if arp:
        h["x-arp-session-id"] = arp
    nonce = _read(NONCE_FILE)
    if nonce:
        h["x-nonce"] = nonce
    return h


# ---------------------------------------------------------------------------
# 0) UPLOAD (her iki model icin ortak)
# ---------------------------------------------------------------------------
def upload_image(image_path):
    image_path = pathlib.Path(image_path)
    if not image_path.exists():
        raise SystemExit(f"HATA: gorsel bulunamadi: {image_path}")

    ctype, _ = mimetypes.guess_type(str(image_path))
    if not ctype:
        ctype = "image/jpeg"

    data = image_path.read_bytes()
    headers = _base_headers()
    headers["content-type"] = ctype

    print(f">> [0] yukleniyor: {image_path.name}  ({len(data)/1024:.0f} KB, {ctype})")
    resp = requests.post(UPLOAD_URL, headers=headers, data=data, timeout=120)
    print(f"   HTTP {resp.status_code}")
    if resp.status_code == 401:
        raise SystemExit("!! 401 = token suresi dolmus (upload).")
    resp.raise_for_status()

    try:
        out = resp.json()
    except ValueError:
        print(resp.text[:1000])
        raise SystemExit("!! upload yaniti JSON degil.")

    blob_id = (
        out.get("id")
        or out.get("imageId")
        or (out.get("images", [{}])[0].get("id") if out.get("images") else None)
    )
    if not blob_id:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        raise SystemExit("!! upload yanitinda id bulunamadi (yapiya bak).")

    print(f"   blob id: {blob_id}")
    return blob_id


# ---------------------------------------------------------------------------
# 1a) GENERATE - NATIVE FIREFLY
# ---------------------------------------------------------------------------
def _generate_native(prompt, start_id, end_id, seed, width, height, num_frames, locale):
    conditions = [{"source": {"id": start_id}, "placement": {"start": 0}}]
    if end_id:
        conditions.append({"source": {"id": end_id}, "placement": {"start": 1}})

    payload = {
        "addOnTransparentBackground": False,
        "prompt": prompt,
        "seeds": [seed],
        "sizes": [{"height": height, "width": width, "numFrames": num_frames}],
        "image": {"conditions": conditions},
        "videoSettings": {},
        "locale": locale,
        "generationMetadata": {"module": "text2video", "submodule": "ff-video-generate"},
        "output": {"storeInputs": True},
    }
    headers = _base_headers()
    headers["content-type"] = "application/json"

    print(">> [1] generate (Firefly native)...")
    resp = requests.post(GENERATE_NATIVE, headers=headers, json=payload, timeout=60)
    print(f"   HTTP {resp.status_code}")
    if resp.status_code == 401:
        raise SystemExit("!! 401 = token suresi dolmus.")
    resp.raise_for_status()

    data = resp.json()
    href = data.get("links", {}).get("result", {}).get("href", "")
    if not href:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        raise SystemExit("!! result href bulunamadi.")
    print(f"   result URL: {href}")
    return href


# ---------------------------------------------------------------------------
# 1b) GENERATE - RAY3.14 (partner / async)
# ---------------------------------------------------------------------------
def _generate_ray314(prompt, start_id, end_id, width, height,
                     duration, negative_prompt, mode, resolution, aspect_ratio):
    reference_blobs = []
    if start_id:
        reference_blobs.append({"id": start_id, "usage": "general", "promptReference": 1})
    if end_id:
        reference_blobs.append({"id": end_id, "usage": "general", "promptReference": 2})

    payload = {
        "modelId": "luma",
        "modelVersion": "3.14-ray",
        "size": {"width": width, "height": height},
        "mode": mode,                       # orn "flex_2"
        "prompt": prompt,
        "negativePrompt": negative_prompt,
        "duration": duration,               # saniye (5, 10 ...)
        "generationMetadata": {"module": "text2video", "submodule": "ff-video-generate"},
        "modelSpecificPayload": {"resolution": resolution, "aspect_ratio": aspect_ratio},
        "output": {"storeInputs": True},
    }
    if reference_blobs:
        payload["referenceBlobs"] = reference_blobs

    headers = _base_headers()
    headers["content-type"] = "application/json"

    print(">> [1] generate (Ray3.14 / partner async)...")
    resp = None
    for attempt in range(1, 6):  # 5 deneme
        resp = requests.post(GENERATE_3P_ASYNC, headers=headers, json=payload, timeout=90)
        print(f"   deneme {attempt}: HTTP {resp.status_code}")
        if resp.status_code == 401:
            raise SystemExit("!! 401 = token suresi dolmus.")
        # Gecici sunucu hatalari -> bekle, tekrar dene
        if resp.status_code in (408, 425, 429, 500, 502, 503, 504):
            wait = 8 * attempt
            print(f"   >> gecici sunucu hatasi (system under load). {wait}s bekleyip tekrar deniyorum...")
            time.sleep(wait)
            continue
        break  # basarili ya da kalici hata -> donguden cik

    if resp.status_code >= 400:
        print("   --- SUNUCU HATA YANITI (ham) ---")
        print(resp.text[:2000])
        print("   --------------------------------")
        if resp.status_code in (408, 425, 429, 500, 502, 503, 504):
            raise SystemExit("!! Adobe sunucusu suanda yogun (gecici). Birkaç dakika sonra tekrar dene.")
        print("   >> gonderilen payload:")
        print(json.dumps(payload, indent=2, ensure_ascii=False)[:2000])
        raise SystemExit(f"!! generate-async HTTP {resp.status_code} — yukaridaki hatayi bana gonder.")

    # Ray3.14 async: result URL RESPONSE HEADER'inda gelir (x-override-status-link).
    # Yanit govdesi genelde {"x-task-status":"ACCEPTED"} gibi bir sey; href govdede degil.
    href = resp.headers.get("x-override-status-link")
    if href:
        href = href.rstrip("/")   # sondaki fazla / temizle
        print(f"   result URL (header): {href}")
        return href

    # Fallback: bazen govdede de olabilir
    try:
        data = resp.json()
    except ValueError:
        data = {}
    href = (
        data.get("links", {}).get("result", {}).get("href")
        or data.get("statusUrl")
        or data.get("resultUrl")
        or data.get("href")
    )
    if not href:
        print(">> generate-async: result URL header'da da govdede de yok.")
        print("   Response headers:")
        for k, v in resp.headers.items():
            print(f"     {k}: {v}")
        print("   Govde:", json.dumps(data, indent=2, ensure_ascii=False)[:1000])
        raise SystemExit("!! result URL bulunamadi — yukaridakini bana gonder.")
    print(f"   result URL: {href}")
    return href


# ---------------------------------------------------------------------------
# 2) POLL RESULT -> presignedUrl  (her iki model icin ortak denenir)
# ---------------------------------------------------------------------------
def poll_result(result_url):
    print(">> [2] sonuc bekleniyor (poll)...")
    start = time.time()

    while time.time() - start < POLL_TIMEOUT:
        resp = requests.get(result_url, headers=_base_headers(), timeout=60)
        elapsed = int(time.time() - start)
        if resp.status_code == 401:
            raise SystemExit("!! 401 = token suresi dolmus (poll).")
        resp.raise_for_status()

        try:
            data = resp.json()
        except ValueError:
            print(f"   [{elapsed:>3}s] JSON degil: {resp.text[:200]}")
            time.sleep(POLL_INTERVAL)
            continue

        status = str(data.get("status", "")).upper()

        if status in ("IN_PROGRESS", "RUNNING", "PENDING", "QUEUED", "PROCESSING"):
            prog = data.get("progress", "")
            print(f"   [{elapsed:>3}s] {status}  {('%'+str(prog)) if prog!='' else ''}")
            time.sleep(POLL_INTERVAL)
            continue

        if status in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            print(json.dumps(data, indent=2, ensure_ascii=False))
            raise SystemExit(f"!! Uretim basarisiz: {status}")

        # Sonucu esnek cikar: native -> outputs[].video.presignedUrl
        url, vid = _extract_video_url(data)
        if url:
            print(f"   [{elapsed:>3}s] TAMAMLANDI  (id: {vid})")
            return url, vid

        # Bilinmeyen ama status yok/SUCCEEDED -> yapiyi bas
        if status in ("", "SUCCEEDED", "SUCCESS", "COMPLETED", "DONE"):
            print(f"   [{elapsed:>3}s] tamamlandi gorunuyor ama video URL cikarilamadi:")
            print(json.dumps(data, indent=2, ensure_ascii=False)[:2500])
            raise SystemExit("!! video URL alani farkli — yukaridaki yapiyi bana gonder, tek satirda eklerim.")

        print(f"   [{elapsed:>3}s] status={status}, bekleniyor...")
        time.sleep(POLL_INTERVAL)

    raise SystemExit("!! ZAMAN ASIMI.")


def _extract_video_url(data):
    """Farkli yanit yapilarindan video URL + id cikarmaya calisir."""
    outputs = data.get("outputs", [])
    if outputs:
        video = outputs[0].get("video", {})
        url = video.get("presignedUrl") or video.get("url")
        if url:
            return url, video.get("id", "video")
        # bazen output dogrudan url tasir
        url = outputs[0].get("presignedUrl") or outputs[0].get("url")
        if url:
            return url, outputs[0].get("id", "video")
    # alternatif alanlar
    for key in ("presignedUrl", "url", "videoUrl", "outputUrl"):
        if data.get(key):
            return data[key], data.get("id", "video")
    return None, None


# ---------------------------------------------------------------------------
# 3) DOWNLOAD
# ---------------------------------------------------------------------------
def download_video(presigned_url, filename):
    OUTPUT_DIR.mkdir(exist_ok=True)
    if not filename.lower().endswith(".mp4"):
        filename += ".mp4"
    out_path = OUTPUT_DIR / filename
    print(f">> [3] indiriliyor -> {out_path.name}")
    with requests.get(presigned_url, stream=True, timeout=120) as r:
        r.raise_for_status()
        done = 0
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                f.write(chunk)
                done += len(chunk)
    print(f"   Kaydedildi: {out_path}  ({done/1024/1024:.1f} MB)")
    return out_path


# ---------------------------------------------------------------------------
# HEPSI BIR ARADA
# ---------------------------------------------------------------------------
def run(prompt, start_image=None, end_image=None, name="firefly_video",
        model="ray3.14",
        # ortak
        width=1920, height=1080, locale="tr-TR",
        # native
        seed=413383, num_frames=128,
        # ray3.14
        duration=5, negative_prompt="cartoon, vector art, & bad aesthetics & poor aesthetic",
        mode="flex_2", resolution="1080p", aspect_ratio="16:9"):
    """
    model: "ray3.14" veya "firefly"
    start_image / end_image: DOSYA YOLU (yuklenip blob id alinir) VEYA hazir blob id (str).
    """
    def _resolve(x, label):
        if x is None:
            return None
        if pathlib.Path(str(x)).exists():
            return upload_image(x)
        print(f">> [0] {label}: hazir blob id kullaniliyor ({x})")
        return x

    start_id = _resolve(start_image, "start")
    end_id   = _resolve(end_image, "end")

    model = model.lower().replace(" ", "")
    if model in ("ray3.14", "ray314", "ray", "luma"):
        href = _generate_ray314(prompt, start_id, end_id, width, height,
                                duration, negative_prompt, mode, resolution, aspect_ratio)
    elif model in ("firefly", "native", "ff"):
        href = _generate_native(prompt, start_id, end_id, seed, width, height, num_frames, locale)
    else:
        raise SystemExit(f"!! bilinmeyen model: {model} (firefly | ray3.14)")

    url, vid = poll_result(href)
    path = download_video(url, name)
    print(f"\n>> BITTI. Video: {path}")
    return path


# ---------------------------------------------------------------------------
# TEST KOSUSU
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # --- TEK SAHNE TESTI ---
    SCENES_DIR = "/Users/onur/Desktop/New Videos/Where did my sister go-German/keyframes"
    scene = "scene_002"
    run(
        model="ray3.14",
        prompt=("[Pull out] The floating thought bubble gently pops as the girl slowly "
                "spins inside the washing machine, revealing the boy and baby leaning in "
                "to stare at the real machine with eyes widening and slow blinks, while a "
                "? symbol appears above the cat's head."),
        start_image=f"{SCENES_DIR}/{scene}/frame_first.jpg",
        end_image=f"{SCENES_DIR}/{scene}/frame_last.jpg",
        name=scene,
        duration=5,
    )
