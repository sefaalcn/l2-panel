"""
core.py — Router/adaptör altyapısı (ortak sözleşme + registry + yardımcılar)
============================================================================
Buradaki hiçbir sey mevcut firefly_gen.py / hailuo_pipeline.py'yi degistirmez;
onlar kutuphane olarak DISARIDAN cagirilir.

Icerik:
  * HERE            -> proje kok klasoru (firefly_gen.py'nin bulundugu yer)
  * read_token/opt  -> token dosyalarini esnek okuma (adaptor basina farkli dosya)
  * Job             -> runner'in adaptore verdigi normalize is paketi
  * AdapterSpec     -> bir adaptorun metasi (key, provider, modes, ready, model_tag...)
  * register/get    -> adaptor registry'si
  * sleep_between   -> generate'ler arasi 4-8 sn random bekleme
  * download_stream / poll_until_done -> yeni adaptorler icin ortak yardimcilar
"""

import sys
import time
import json
import random
import pathlib
from dataclasses import dataclass, field
from typing import Callable, Optional

# Proje kok klasoru = video_router/'un bir ust dizini (firefly_gen.py burada).
HERE = pathlib.Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))  # firefly_gen / hailuo_pipeline importu icin


# ---------------------------------------------------------------------------
# TOKEN / DOSYA OKUMA (adaptor basina esnek)
# ---------------------------------------------------------------------------
def read_optional(name):
    """Proje kokunde bir metin dosyasini oku; yoksa None don."""
    p = HERE / name if not str(name).startswith("/") else pathlib.Path(name)
    if p.exists():
        txt = p.read_text(encoding="utf-8").strip()
        return txt or None
    return None


def read_token(name):
    """Zorunlu token dosyasi. 'Bearer ' onekini temizler."""
    txt = read_optional(name)
    if not txt:
        raise SystemExit(f"HATA: {name} bulunamadi/bos (F12'den yenile).")
    return txt.replace("Bearer ", "").strip()


# ---------------------------------------------------------------------------
# JOB — runner'in adaptore verdigi normalize is paketi
# ---------------------------------------------------------------------------
@dataclass
class Job:
    scene: dict                      # ham sahne dict'i (index, label, frame_mode, ...)
    variant: str                     # "v1" / "v2" / "v3"
    prompt: str                      # secili varyant metni
    start_image: Optional[str]       # frame_first.jpg yolu veya None
    end_image: Optional[str]         # frame_last.jpg yolu veya None
    out_path: pathlib.Path           # nereye inecek (tam yol, .mp4 dahil)
    duration: int = 5
    video_dir: Optional[str] = None  # videonun kok klasoru (Hailuo: token/cookie/project buradan)
    resolution: Optional[str] = None # "720p" | "1080p" | None(=adaptor varsayilani). firefly cozunurluk.
    # --- vid_id kaydi (M1 onkosulu: submit basarili olunca video kaybini onle) ---
    on_submit: Optional[Callable] = None  # adaptor submit OK olunca cagirir: on_submit(vid_id/href).
                                          #   runner bunu progress'e {submitted, vid_id} yazar (proses olse bile kayip yok).
    resume_vid_id: Optional[str] = None   # progress'te submitted+vid_id varsa: YENIDEN URETME, bununla poll+download.
    # --- M1 Pool (Stage 2) ---
    out_name: Optional[str] = None        # progress anahtari: "{label}_{model_tag}_{variant}.mp4"
    submit_meta: Optional[dict] = None    # set_submitted/done/failed kaydinin meta'si (provider/adapter/model_tag/...)
    skip_queue_gate: bool = False         # Pool modunda True -> adaptor wait_for_queue'yu ATLA (self-deadlock onle)
    pre_generate: Optional[Callable] = None  # adaptor generate'ten HEMEN once cagirir -> Pool global submit kapisi (pacing)
    prompt_optimizer: bool = True         # Hailuo: True=optimize(useOriginPrompt=False, mevcut) / False=verbatim(=True)

    @property
    def label(self):
        return self.scene.get("label", f"scene_{self.scene.get('index', 0):03d}")


# ---------------------------------------------------------------------------
# ADAPTER SPEC + REGISTRY
# ---------------------------------------------------------------------------
@dataclass
class AdapterSpec:
    key: str                         # router'in dondurdugu anahtar, orn "kling2.5"
    provider: str                    # "firefly" | "hailuo"
    model_tag: str                   # dosya adinda gecen kisa etiket, orn "kling"
    modes: set                       # desteklenen frame_mode'lar {"start_only"} gibi
    ready: bool                      # False => PLACEHOLDER (park et, uretme)
    generate: Callable               # generate(job) -> pathlib.Path
    token_files: list = field(default_factory=list)  # bu adaptorun okudugu dosyalar (bilgi amacli)
    description: str = ""


_REGISTRY = {}


def register(spec: AdapterSpec):
    if spec.key in _REGISTRY:
        raise RuntimeError(f"Adaptor anahtari coklandi: {spec.key}")
    _REGISTRY[spec.key] = spec
    return spec


def get(key) -> AdapterSpec:
    if key not in _REGISTRY:
        raise KeyError(f"Kayitli olmayan adaptor: {key}  (kayitli: {sorted(_REGISTRY)})")
    return _REGISTRY[key]


def all_specs():
    return dict(_REGISTRY)


# ---------------------------------------------------------------------------
# GENERATE'LER ARASI RANDOM BEKLEME (kota yavaslamasi + 408 azaltma)
# ---------------------------------------------------------------------------
def sleep_between(lo=4, hi=8, why=""):
    wait = random.uniform(lo, hi)
    tail = f" ({why})" if why else ""
    print(f"   .. {wait:.1f}s bekleniyor{tail}")
    time.sleep(wait)


# ---------------------------------------------------------------------------
# RETRY — gecici ag hatalarina karsi (tam batch'te blip yuzunden sahne kaybini onler)
# ---------------------------------------------------------------------------
_TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}


def retry(fn, *, attempts=3, backoffs=(5, 15, 45), label=""):
    """
    fn()'i cagir; GECICI hatada exponential backoff ile tekrar dene:
      - SSLError / ConnectionError / Timeout (ag titremesi)
      - HTTPError 5xx / 408 / 425 / 429
    KALICI hatalar HEMEN yukari firlatilir (retry EDILMEZ):
      - HTTPError 4xx (401/403 token, diger 4xx)
      - SystemExit (ff/hp bunu 401/403 icin firlatir) -> BaseException, zaten yakalanmaz
      - diger beklenmedik exception'lar
    """
    import requests
    last = None
    for i in range(attempts):
        try:
            return fn()
        except requests.exceptions.HTTPError as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code not in _TRANSIENT_STATUS:
                raise                      # kalici (4xx) -> hemen dur
            last = e
        except (requests.exceptions.SSLError,
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            last = e                       # gecici ag hatasi
        if i < attempts - 1:
            wait = backoffs[min(i, len(backoffs) - 1)]
            print(f"   [retry {label}] gecici hata: {type(last).__name__} — "
                  f"{wait}s sonra ({i + 2}/{attempts}. deneme)")
            time.sleep(wait)
    raise last


# ---------------------------------------------------------------------------
# OUTPUT SINK — cikti hedefi soyutlamasi (simdi local, ileride Drive)
# ---------------------------------------------------------------------------
# Adaptor HER ZAMAN once bir LOCAL yola yazar (staging). Sonra sink.finalize()
# o dosyayi asil hedefe tasir/yukler. LocalSink icin finalize = no-op.
# Ileride DriveSink eklenince adaptorler DEGISMEZ; sadece burada yeni sinif +
# cli'da secim gerekir (rclone ya da Drive API ile).
class OutputSink:
    def local_path(self, name) -> "pathlib.Path":
        """Adaptorun yazacagi local staging yolu."""
        raise NotImplementedError

    def exists(self, name) -> bool:
        """Bu isimli cikti hedefte zaten var mi? (atlama kontrolu)"""
        raise NotImplementedError

    def finalize(self, local_path) -> str:
        """Local dosyayi asil hedefe koy; nihai referansi (yol/URL) don."""
        raise NotImplementedError

    def describe(self) -> str:
        return self.__class__.__name__


class LocalSink(OutputSink):
    """Cikti dogrudan local klasore. finalize = dosya zaten yerinde (no-op)."""
    def __init__(self, root):
        self.root = pathlib.Path(root)

    def local_path(self, name):
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root / name

    def exists(self, name):
        p = self.root / name
        return p.exists() and p.stat().st_size > 0

    def finalize(self, local_path):
        return str(local_path)

    def describe(self):
        return f"LocalSink({self.root})"


# Ileride:  class DriveSink(OutputSink): local_path -> gecici staging; finalize ->
#           rclone/Drive API ile yukle, exists -> Drive'da ara. (Simdi YAZILMADI.)


# ---------------------------------------------------------------------------
# ORTAK YARDIMCILAR — yeni adaptorler icin (Ray3.14 kendi firefly_gen'inkini kullanir)
# ---------------------------------------------------------------------------
def download_stream(url, out_path):
    """Presigned URL'den mp4 indir."""
    import requests
    out_path = pathlib.Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    done = 0
    with requests.get(url, stream=True, timeout=180) as r:
        r.raise_for_status()
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                f.write(chunk)
                done += len(chunk)
    print(f"   indirildi: {out_path.name}  ({done/1024/1024:.1f} MB)")
    return out_path


def poll_until_done(result_url, headers_fn, extract_video_url,
                    interval=5, timeout=600):
    """
    Genel poll dongusu (yeni adaptorler icin).
      headers_fn()          -> her istek icin header dict'i (token taze okunur)
      extract_video_url(js) -> (video_url, video_id) ya da (None, None)
    Yanit yapisi Ray3.14'e uymuyorsa adaptor kendi poll'unu yazabilir.
    """
    import requests
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.get(result_url, headers=headers_fn(), timeout=60)
        if resp.status_code == 401:
            raise SystemExit("!! 401 = token suresi dolmus (poll).")
        resp.raise_for_status()
        try:
            data = resp.json()
        except ValueError:
            time.sleep(interval)
            continue
        status = str(data.get("status", "")).upper()
        if status in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            raise SystemExit(f"!! Uretim basarisiz: {status}")
        url, vid = extract_video_url(data)
        if url:
            return url, vid
        time.sleep(interval)
    raise SystemExit("!! ZAMAN ASIMI (poll).")
