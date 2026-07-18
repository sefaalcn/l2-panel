"""
_hailuo.py — Hailuo ailesi ortak akisi (2.0 / 2.3)
==================================================
hailuo_pipeline.py'yi (import adi hp) DEGISTIRMEDEN kutuphane olarak kullanir.
hailuo20 ve hailuo23 SADECE model ID ile ayrisir; ikisi de submit()'i cagirir.

Akis (step_hailuo deseninin tek-sahne hali):
  hp.setup_paths(video_dir)  -> globaller (BASE_DIR, HAILUO_PROJECT, token/cookie yollari)
  hp.HAILUO_MODEL = model_id -> 2.0=23210 ; 2.3 ileride (curl ile)
  frame_mode'a gore upload (OSS + yy imza) -> hl_generate_video -> result poll -> indir

Token/cookie/project: VIDEO klasorunde (BASE_DIR). ensure_token() (interaktif) CAGRILMAZ;
get_hailuo_token() salt-oku, sureli dolmussa hp temiz hata verir -> runner 'failed'.
"""

import re
import time
import pathlib
from urllib.parse import urlencode

import requests

from .. import core
import hailuo_pipeline as hp

POLL_INTERVAL = 15
POLL_TIMEOUT  = 1800        # 30 dk: video sunucuda; SSL firtinasi/internet kesintisini (dakikalar) atlat
DURATION      = 6           # hl_generate_video'nun kanitli varsayilani (job.duration degil)

# BITEN videonun URL'i: detay sayfasi HTML'inde GOMULU (Next.js streaming).
#   Eski /v1/.../result endpoint'i 404 (Hailuo degistirmis); processing feed video bitince
#   bosaliyor. Cozum: my-work-detail sayfasini vid_id ile cek -> HTML'den download URL'i regex'le cikar.
#   Sayfa iki URL tasir: downloadURLWithWatermark ve downloadURLWithoutWatermark -> WATERMARKSIZ tercih.
DETAIL_URL = hp.HAILUO_BASE + "/my-work-detail/ai-video/{vid}?source-page=create"

# HTML JSON escape'li: \"downloadURLWithoutWatermark\":\"https://cdn...mp4\"
_WO_RE = re.compile(r'downloadURLWithoutWatermark\\":\\"(https://cdn\.hailuoai\.video/moss[^\\]+?\.mp4)')
_WM_RE = re.compile(r'downloadURLWithWatermark\\":\\"(https://cdn\.hailuoai\.video/moss[^\\]+?\.mp4)')


def _normalize_prompt(prompt: str) -> str:
    # "[Push in, Pan left]" -> "[Push in,Pan left]"  (Hailuo panel format, step_hailuo:651)
    return re.sub(r'^\[([^\]]+)\]', lambda m: '[' + m.group(1).replace(', ', ',') + ']', prompt or "")


def _extract_url(html: str, vid_id: str):
    """
    Sayfada 60+ video olabilir; SADECE bizim vid_id'ye ait URL'i sec.
    vid_id gecislerinin HERHANGI birinden hemen SONRA (<=3000 char) gelen download URL'i al
    (hero = bizim video, chunk'i vid_id'ye komsu). Once watermarksiz, yoksa watermark'li.
    """
    vids = [m.start() for m in re.finditer(re.escape(vid_id), html)]
    if not vids:
        return None, None
    for rex, label in ((_WO_RE, "watermarksiz"), (_WM_RE, "watermarkli")):
        cands = [(m.start(), m.group(1)) for m in rex.finditer(html)]
        best, best_d = None, None
        for vpos in vids:
            for upos, u in cands:
                d = upos - vpos
                if 0 <= d <= 3000 and (best_d is None or d < best_d):
                    best_d, best = d, u
        if best:
            return best, label
    return None, None


def _poll_download(vid_id: str, token: str, out_path: pathlib.Path) -> pathlib.Path:
    """
    my-work-detail HTML'ini poll et; vid_id'ye ait download URL belirince indir.
    ASIMETRIK retry (M1 onkosulu): video ZATEN sunucuda -> poll'u kaybetmek sacma.
      - poll cekimi tukenirse (SSL firtinasi/kesinti) POLL'U ABORT ETME; POLL_TIMEOUT'a kadar surdur.
      - download: 5 deneme, uzun backoff.
    """
    start = time.time()
    headers = hp.hl_headers(token)
    headers["Accept"] = "text/html,application/xhtml+xml"
    def _fetch():
        resp = requests.get(DETAIL_URL.format(vid=vid_id), headers=headers, timeout=30)
        if resp.status_code in (401, 403):
            raise SystemExit("!! [POLL] Hailuo token suresi dolmus.")  # kalici -> retry yok
        resp.raise_for_status()          # 5xx -> retry, diger 4xx -> retry helper durdurur
        return resp

    while time.time() - start < POLL_TIMEOUT:
        # HTML cekimi gecici SSL/ag hatasina karsi retry'li. Retry TUKENIRSE bile poll'u
        # ABORT ETME (video sunucuda) -> logla, bekle, dongude israr et.
        try:
            r = core.retry(_fetch, label="hailuo-poll")
        except SystemExit:
            raise                        # 401/403 = kalici token hatasi -> yukari
        except Exception as e:           # SSL/Conn/Timeout tukendi -> poll SURUYOR
            elapsed = int(time.time() - start)
            print(f"   [{elapsed:>3}s] [POLL] cekim basarisiz ({type(e).__name__}) — poll suruyor")
            time.sleep(POLL_INTERVAL)
            continue
        murl, label = _extract_url(r.text, vid_id)
        elapsed = int(time.time() - start)
        if murl:
            print(f"   [{elapsed:>3}s] HAZIR ({label}): ...{murl[-60:]}")
            return core.retry(lambda: core.download_stream(murl, out_path),
                              label="hailuo-download", attempts=5, backoffs=(5, 15, 30, 45, 60))
        print(f"   [{elapsed:>3}s] henuz hazir degil (bekleniyor)")
        time.sleep(POLL_INTERVAL)
    raise SystemExit("!! [POLL] Hailuo ZAMAN ASIMI.")


def submit(job: core.Job, model_id: str, tag: str) -> pathlib.Path:
    if not job.video_dir:
        raise SystemExit("!! Hailuo: video_dir yok (runner config'ten gelmeli).")

    hp.setup_paths(job.video_dir)      # BASE_DIR + HAILUO_PROJECT (hailuo_project.txt) + token/cookie yollari
    hp.HAILUO_MODEL = model_id         # 2.0 = 23210
    token = hp.get_hailuo_token()      # salt-oku (interaktif ensure_token DEGIL)

    # --- RESUME: vid_id zaten var (submit onceki koşuda basarili olmustu) -> YENIDEN URETME ---
    if job.resume_vid_id:
        print(f">> [RESUME] {tag}: vid_id {job.resume_vid_id} ile poll+download (yeniden uretim YOK)")
        path = _poll_download(job.resume_vid_id, token, job.out_path)
        print(f"\n>> BITTI ({tag}, resume). Video: {path}")
        return pathlib.Path(path)

    mode = (job.scene.get("frame_mode") or "both").lower()

    # --- Upload (frame_mode'a gore, step_hailuo deseni) — her upload retry'li (SUBMIT asamasi) ---
    def _up(path, add_noise=False):
        return core.retry(lambda: hp.hl_upload_image(pathlib.Path(path), token, add_noise=add_noise),
                          label="hailuo-upload")

    if mode == "end_only":
        if not job.end_image:
            raise SystemExit("!! end_only ama frame_last yok.")
        first = last = _up(job.end_image)
    elif mode == "both":
        if not (job.start_image and job.end_image):
            raise SystemExit("!! both ama frame eksik.")
        print(">> [0] first frame upload...")
        first = _up(job.start_image)
        time.sleep(4)
        print(">> [0] last frame upload...")
        last = _up(job.end_image, add_noise=True)
    else:  # start_only
        if not job.start_image:
            raise SystemExit("!! start_only ama frame_first yok.")
        first = last = _up(job.start_image)
    time.sleep(4)

    # --- Kuyruk kontrolu (generate oncesi) ---
    # Pool modunda ATLA: wait_for_queue kendi islerimizi de sayar -> N worker ayni sayacta self-deadlock.
    # Pool'da semaphore/ThreadPool(N) birincil fren; kuyruk kapisi Pool disinda (sirali) gecerli.
    if job.skip_queue_gate:
        print("   [pool] wait_for_queue atlandi (semaphore birincil fren)")
    else:
        try:
            hp.wait_for_queue(token, job.label)
        except Exception as e:
            print(f"   wait_for_queue atlandi: {e}")

    # --- Generate ---
    prompt = _normalize_prompt(job.prompt)
    # SURE<->COZUNURLUK cifti (OLCULDU): 10sn ancak "768" (720p) ile kabul; 1080+10 -> 2400001.
    # 6sn (varsayilan) 1080p'de. video_duration=10 istenirse otomatik 720p'ye dus + UYAR (sessiz DEGIL).
    _dur = job.duration or DURATION
    _res = "768" if _dur == 10 else "1080"
    if _res != "1080":
        _clash = " (--resolution 1080p istegi SURE tarafindan ezildi)" if (job.resolution and "1080" in str(job.resolution)) else ""
        print(f"   [UYARI-COZ] {_dur}sn icin cozunurluk 720p'ye dusuruldu (res={_res}); 1080p yalniz 6sn.{_clash}")
    if job.pre_generate:                # POOL global submit kapisi (pacing): generate'ten HEMEN once, tek tek gec
        job.pre_generate()
    print(f">> [1] generate ({tag}, model {model_id}, mode={mode}, dur={_dur}, res={_res})...")
    # Generate retry'li: yalniz gecici AG hatasi tekrar dener. hl_generate_video API hatasinda
    # RuntimeError firlatir (kalici) -> retry edilmez. NOT: ag hatasi istek SUNUCUYA ULASTIKTAN
    # sonra olursa nadiren cift-uretim olabilir; pratikte blip'ler baglanti oncesi olur.
    # prompt_optimizer=True (default) -> useOriginPrompt=False (optimize, mevcut). False -> True (verbatim).
    vid_id = core.retry(lambda: hp.hl_generate_video(
        first[0], first[1], first[2],
        last[0], last[1], last[2],
        prompt, token, frame_mode=mode, duration=_dur, resolution=_res,
        use_origin_prompt=(not job.prompt_optimizer),
    ), label="hailuo-generate")
    print(f"   vid_id: {vid_id}")
    if job.on_submit:                  # SUBMIT OK -> vid_id'yi HEMEN kaydet (proses olse bile kayip yok)
        job.on_submit(vid_id)
    hp.hl_heartbeat(token)             # kuyrugu canli tut

    # --- Poll + OTOMATIK indir ---
    print(">> [2] sonuc bekleniyor (poll)...")
    path = _poll_download(vid_id, token, job.out_path)
    print(f"\n>> BITTI ({tag}). Video: {path}")
    return pathlib.Path(path)
