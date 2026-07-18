"""
runner.py — pipeline surucusu (Firefly ve Hailuo ortak)
=======================================================
Sahneleri index sirasiyla isler. Her sahne frame_mode'una gore router'dan bir
adaptore yonlendirilir. Her sahnenin TUM varyantlari AYNI modele gider.

Ozellikler:
  * Cok varyant: --variants v1,v3  (yoksa interaktif sorar)
  * Dosya adi: scene_XXX_<model_tag>_<variant>.mp4  (model karsilastirmasi icin)
  * Atlama: mp4 zaten varsa ya da progress'te done ise uretmez
  * Park: adaptor ready=False ise cokmeden atlar, pending_no_adapter yazar
  * Random bekleme: her generate oncesi 4-8 sn (kota/408 azaltma)
  * Deterministik ordinal: start_only'lar arasi 0-tabanli sira (resume-guvenli)
  * --dry-run: hic API cagirmadan plan (kredi harcamaz)

Ayri cikti/progress dosyalari sayesinde Firefly ve Hailuo AYNI ANDA calisabilir.
"""

import os
import sys
import time
import json
import pathlib
from dataclasses import dataclass, field
from typing import Optional

from . import core
from . import router
from . import moderation
from . import adapters  # noqa: F401 — import registry'yi doldurur
from .progress import load_progress, save_progress, ProgressStore  # noqa: F401 (ayri katman)
from .pool import Pool  # M1 is havuzu (ayri katman)


# ---------------------------------------------------------------------------
# YAPILANDIRMA
# ---------------------------------------------------------------------------
# Provider'a gore generate'ler ARASI random bekleme (saniye).
#   Firefly: sirali + hizli (3p endpoint kendi retry'sini yapar).
#   Hailuo : kuyruklu + yavas — bot gorunmemek ve tikanmamak icin UZUN.
#            (orijinal hailuo_pipeline: varyant 120-180s, sahne 160-400s)
#   Ayrica Hailuo adaptorde wait_for_queue (kuyruk<4) + heartbeat de uygular (cift koruma).
PACING = {
    # firefly 8-20s: 122 sahnelik uzun koşuda ihtiyat (12'lik koşuda 4-8s sorunsuzdu; tek
    # hata 451/moderasyondu, hiz degil). DENEYSEL: 429/rate-limit gelirse artir, sorunsuz
    # gecerse sonraki koşularda dusurmeyi dene. (bkz. ROADMAP — Firefly pacing deneysel)
    "firefly": {"scene": (8, 20),    "variant": (8, 20)},
    # hailuo 20-60 (ASAMA 1, 17 Tem): pacing = is BITTIKTEN sonra olu zaman (kuyruk 73/75 bostu, %26).
    # 90-140'tan 20-60'a kisaltildi; RASTGELE kalir (bot korumasi). pacing=0 testinde ceza yok, 20-60 daha
    # ihtiyatli. wait_for_queue gercek fren. Rate-limit/low-speed escalation gelirse geri artir. (bkz. ROADMAP)
    "hailuo":  {"scene": (20, 60),   "variant": (20, 60)},
}

# video_duration: model-basina KABUL listesi + default (sn). Studio 'video_duration' DOLUYSA modele
# gore dogrula; YOKSA model default (regresyon yok — bugunku sabitlerle ayni). Olculdu: Hailuo {6,10},
# Ray {5}, Runway {8}, Kling {5}. NOT: JSON'daki 'duration' alani OLU (194 sahnede 0), o DEGIL.
# ÖLÇÜLDÜ (17 Tem, curl): Hailuo 10sn MUMKUN ama yalniz "768"(720p) ile — 10+1080 -> 2400001. Yani
# (sure,cozunurluk) BAGLI: {6:1080, 10:768}. Adaptor (_hailuo) duration'a gore resolution'i secer + UYARIR.
# Accept-list burada yalniz SURE: Hailuo {6,10}. video_duration=10 -> 10sn@720p (adaptorde otomatik).
_DURATION = {
    "hailuo20": ({6, 10}, 6), "hailuo23": ({6, 10}, 6),
    "ray314": ({5}, 5), "runway": ({8}, 8), "kling": ({5}, 5),
}


def _resolve_duration(scene, model_tag):
    """(duration, uyari|None). video_duration DOLUYSA modele gore dogrula; YOKSA model default."""
    accept, default = _DURATION.get(model_tag, (None, None))
    req = scene.get("video_duration")            # YENI alan; olu 'duration' DEGIL
    if req is None or req == "":
        return default, None
    try:
        req = int(req)
    except (ValueError, TypeError):
        return default, f"{model_tag}: video_duration gecersiz ({scene.get('video_duration')!r}) -> {default}s"
    if accept is None:                           # taninmayan model -> istegi aynen gecir
        return req, None
    if req in accept:
        return req, None
    nearest = min(accept, key=lambda a: abs(a - req))
    return nearest, f"{model_tag}: {req}s desteklenmiyor (kabul {sorted(accept)}) -> en yakin {nearest}s"


_KNOWN_VIDEO_MODELS = {"hailuo"}


def _validate_scene(s, mode, first_img, last_img, model_tag):
    """Fix #2 — dry-run dogrulama. frame_mode<->dosya + video_duration + video_model. Uyari listesi doner."""
    w = []
    need_first = mode in ("both", "start_only")
    need_last = mode in ("both", "end_only")
    if need_first and not first_img.exists():
        w.append(f"frame_mode={mode} ama {first_img.name} YOK")
    if need_last and not last_img.exists():
        w.append(f"frame_mode={mode} ama {last_img.name} YOK (016/057 gibi sessiz dusme)")
    _d, _dw = _resolve_duration(s, model_tag)
    if _dw:
        w.append(_dw)
    vm = s.get("video_model")
    if vm and vm not in _KNOWN_VIDEO_MODELS:
        w.append(f"video_model taninmiyor: {vm!r} (bilinen: {sorted(_KNOWN_VIDEO_MODELS)})")
    return w


# Fix #3 — bilinmeyen alan uyarisi. Studio'ya alan ekleniyor, katmanlar arasi sessizce kayboluyor.
_CONSUMED_FIELDS = {   # pipeline'in (gemini_direct + runner + adaptor) GERCEKTEN okudugu alanlar
    "index", "label", "frame_mode", "scene_description", "scene_desc", "frame_first_seek",
    "frame_last_seek", "video_duration", "video_model", "v1", "v2", "v3",
}
# KESIN Studio v2 semasi (public/scene-studio.js buildExportData'dan dogrudan cikarildi — tahmin DEGIL).
_SCHEMA_V2 = _CONSUMED_FIELDS | {   # bilinen ama pipeline kullanmayan (Studio-ici / henuz kullanilmayan)
    "type", "start", "end", "duration", "scene_type", "scene_path", "frame_first_video",
    "frame_last_video", "swap_first", "swap_last", "frame_swapped_first", "frame_swapped_last",
    "version", "note_confirmed", "alternative_scene", "camera_angle", "camera_angles", "scene_main_topic",
    "geekfree", "emotion", "face_visible", "source", "start_ms", "end_ms", "frame_first_seek_ms", "frame_last_seek_ms",
}


def unknown_fields(scenes):
    """present alanlari _SCHEMA_V2 ile karsilastir. (known_unread, unknown) sirali listeler doner.
    TEK KAYNAK: hem dry-run print'i hem L2.5 preflight bunu cagirir (kopya YOK)."""
    present = set()
    for s in scenes:
        if isinstance(s, dict):
            present |= set(s.keys())
    unknown = present - _SCHEMA_V2                 # semada YOK -> yeni/Studio eklemis
    known_unread = (present - _CONSUMED_FIELDS) - unknown
    return sorted(known_unread), sorted(unknown)


def _check_unknown_fields(scenes, tag):
    """dry-run yazdirici — unknown_fields()'i cagirir (kopya degil)."""
    known_unread, unknown = unknown_fields(scenes)
    if known_unread:
        print(f"   [ALAN] {tag}: okunmayan (bilinen, pipeline kullanmiyor): {known_unread}")
    if unknown:
        print(f"   [ALAN] ⚠ {tag}: BILINMEYEN alan (Studio eklemis olabilir, ele alinmali): {unknown}")


@dataclass
class PipelineConfig:
    provider: str                     # "firefly" | "hailuo"
    prompts_json: pathlib.Path
    keyframes_dir: pathlib.Path
    video_dir: pathlib.Path           # videonun kok klasoru (Hailuo token/cookie/project buradan)
    sink: core.OutputSink             # cikti hedefi (LocalSink; ileride DriveSink)
    progress_file: pathlib.Path
    variants: list                    # ["v1","v3"] gibi
    start_model: str = "kling"        # firefly start_only: kling | runway | alternate
    scenes_filter: Optional[set] = None   # None => hepsi
    dry_run: bool = False
    duration: int = 5
    resolution: Optional[str] = None      # "720p"|"1080p"|None. firefly: ray314 varsayilan 720p, kling 1080p.
    concurrency: Optional[int] = None     # M1 Pool: None=sirali (mevcut yol). int=Pool yolu (1=regresyon, 2+=paralel).
    prompt_optimizer: bool = True         # Hailuo: True=optimize (mevcut) / False=verbatim (useOriginPrompt=True)


# ---------------------------------------------------------------------------
# VARYANT SECIMI (bayrak yoksa interaktif)
# ---------------------------------------------------------------------------
def parse_variants_flag(value: str) -> list:
    """'v1,v3' -> ['v1','v3'] ; normalize + tekille + sirala."""
    out = []
    for part in (value or "").split(","):
        p = part.strip().lower()
        if not p:
            continue
        if not p.startswith("v"):
            p = "v" + p
        if p not in out:
            out.append(p)
    if not out:
        raise SystemExit("HATA: --variants bos/gecersiz (orn: v1,v3).")
    return out


def select_variants_interactive() -> list:
    print("\nBu video icin hangi varyantlari ureteyim?")
    print("  (1) sadece v1")
    print("  (2) sadece v3   [cartoon gag / sok]")
    print("  (3) v1 + v2 + v3")
    print("  (4) ozel giris  (orn: v1,v3)")
    try:
        choice = input("Secim [1-4]: ").strip()
    except EOFError:
        raise SystemExit("HATA: interaktif secim yok (TTY yok). --variants ile ver.")
    if choice == "1":
        return ["v1"]
    if choice == "2":
        return ["v3"]
    if choice == "3":
        return ["v1", "v2", "v3"]
    if choice == "4":
        raw = input("  Varyantlar (virgullu): ").strip()
        return parse_variants_flag(raw)
    raise SystemExit("HATA: gecersiz secim.")


def parse_start_model_flag(value: str) -> str:
    v = (value or "").strip().lower()
    if v not in ("kling", "runway", "alternate"):
        raise SystemExit(f"HATA: --start-model gecersiz: {value} (kling|runway|alternate).")
    return v


def select_start_model_interactive() -> str:
    """Sadece firefly icin, start_only sahnelerin modeli — video basinda BIR KEZ sorulur."""
    print("\nstart_only sahneler icin hangi model?")
    print("  (1) Kling 2.5   [1080p, VARSAYILAN]")
    print("  (2) Runway 4.5  [720p]")
    print("  (3) Donusumlu   [cift ordinal->Kling, tek->Runway]")
    try:
        choice = input("Secim [1-3, bos=Kling]: ").strip()
    except EOFError:
        return "kling"
    mapping = {"": "kling", "1": "kling", "2": "runway", "3": "alternate"}
    if choice not in mapping:
        raise SystemExit("HATA: gecersiz secim.")
    return mapping[choice]


# ---------------------------------------------------------------------------
# SAHNE ARALIGI (--scenes 1-3,7)
# ---------------------------------------------------------------------------
def parse_scenes_arg(arg: str) -> set:
    scenes = set()
    for part in arg.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            s, e = part.split("-")
            scenes.update(range(int(s), int(e) + 1))
        else:
            scenes.add(int(part))
    return scenes


# ---------------------------------------------------------------------------
# PROGRESS
# ---------------------------------------------------------------------------
# load_progress / save_progress (ATOMIK) + ProgressStore (tek-yazici) -> progress.py (ayri katman;
# Pool + L2.5 de kullanir). Geriye-uyum: bu isimler asagida import ediliyor.


# ---------------------------------------------------------------------------
# ANA DONGU
# ---------------------------------------------------------------------------
def run(cfg: PipelineConfig):
    if not cfg.prompts_json.exists():
        raise SystemExit(f"HATA: prompt JSON yok: {cfg.prompts_json}")

    scenes = json.loads(cfg.prompts_json.read_text(encoding="utf-8"))
    scenes.sort(key=lambda s: s.get("index", 0))
    progress = load_progress(cfg.progress_file)

    mode_tag = "DRY-RUN (kredi harcanmaz)" if cfg.dry_run else "GERCEK URETIM"
    print("=" * 64)
    print(f"  {cfg.provider.upper()} PIPELINE — {mode_tag}")
    print(f"  varyantlar : {','.join(cfg.variants)}")
    if cfg.provider == "firefly":
        print(f"  start_only : {cfg.start_model}")
    print(f"  cikti      : {cfg.sink.describe()}")
    print(f"  progress   : {cfg.progress_file.name}")
    if cfg.scenes_filter:
        print(f"  sahne filt : {sorted(cfg.scenes_filter)}")
    print("=" * 64)

    # Fix #3 — bilinmeyen alan uyarisi (dry-run): prompts JSON + kaynak Studio JSON (yeni alanlari yakala).
    if cfg.dry_run:
        _check_unknown_fields(scenes, "prompts-JSON")
        import glob as _glob
        for _sp in sorted(_glob.glob(str(pathlib.Path(cfg.video_dir) / "*scenes*.json")))[:1]:
            try:
                _src = json.loads(pathlib.Path(_sp).read_text(encoding="utf-8"))
                _src = _src if isinstance(_src, list) else _src.get("scenes", [])
                _check_unknown_fields(_src, f"kaynak({pathlib.Path(_sp).name})")
            except Exception as _e:
                print(f"   [ALAN] kaynak JSON okunamadi: {_e}")

    # M1 POOL yolu (opt-in, --concurrency). None=SIRALI (mevcut, dokunulmaz). Dry-run her zaman sirali.
    if cfg.concurrency is not None and not cfg.dry_run:
        return _run_pool(cfg, scenes, progress)

    tally = {"produced": 0, "skipped": 0, "parked": 0, "failed": 0, "planned": 0,
             "submitted": 0, "softened": 0}
    by_model = {}   # model_tag -> adet (dry-run ozet icin)
    start_only_ord = 0
    run_generated = False          # tum kosuda ilk generate oldu mu (ilk once bekleme yok)
    pace = PACING.get(cfg.provider, {"scene": (4, 8), "variant": (4, 8)})

    for s in scenes:
        idx = s.get("index", 0)
        label = s.get("label", f"scene_{idx:03d}")
        mode = s.get("frame_mode", "both")

        # Ordinal TAM liste uzerinden hesaplanir (filtre/atlamadan bagimsiz -> deterministik)
        ordinal = start_only_ord
        if mode == "start_only":
            start_only_ord += 1

        if cfg.scenes_filter and idx not in cfg.scenes_filter:
            continue

        adapter_key = router.route(cfg.provider, mode, ordinal, cfg.start_model)
        spec = core.get(adapter_key)

        # Keyframe yollari — frame_mode'a duyarli
        #   both       : start=frame_first (gerekli), end=frame_last (varsa)
        #   start_only : start=frame_first (gerekli), end=None
        #   end_only   : start=None,        end=frame_last (gerekli, promptReference 2)
        scene_dir = cfg.keyframes_dir / label
        first_img = scene_dir / "frame_first.jpg"
        last_img = scene_dir / "frame_last.jpg"
        if mode == "end_only":
            start_arg = None
            end_arg = str(last_img) if last_img.exists() else None
            required = last_img
        else:
            start_arg = str(first_img) if first_img.exists() else None
            end_arg = str(last_img) if (mode == "both" and last_img.exists()) else None
            required = first_img

        ord_note = f" ord={ordinal}" if mode == "start_only" else ""
        print(f"\n--- {label}  (mode={mode}{ord_note}) -> {adapter_key} "
              f"[{'HAZIR' if spec.ready else 'PARK'}] ---")

        # Fix #2 — dry-run dogrulama: frame_mode<->dosya + video_duration + video_model (koşu baslamadan uyar).
        if cfg.dry_run:
            for _w in _validate_scene(s, mode, first_img, last_img, spec.model_tag):
                print(f"   [DOGRULAMA] ⚠ {_w}")

        scene_generated = False    # bu sahnede ilk generate oldu mu (sahne-arasi vs varyant-arasi)

        for variant in cfg.variants:
            out_name = f"{label}_{spec.model_tag}_{variant}.mp4"
            by_model[spec.model_tag] = by_model.get(spec.model_tag, 0) + 1

            # 1) Hedefte zaten var mi? (sink'e sorulur -> ileride Drive de olabilir)
            if cfg.sink.exists(out_name):
                print(f"   [{variant}] ATLA (zaten var): {out_name}")
                tally["skipped"] += 1
                continue

            # 2) Adaptor hazir degil -> park
            if not spec.ready:
                print(f"   [{variant}] PARK (adaptor yok: {adapter_key}): {out_name}")
                if not cfg.dry_run:
                    progress[out_name] = {
                        "status": "pending_no_adapter", "provider": cfg.provider,
                        "adapter": adapter_key, "model_tag": spec.model_tag,
                        "variant": variant, "scene": label, "mode": mode,
                    }
                    save_progress(cfg.progress_file, progress)
                tally["parked"] += 1
                continue

            # 3) Uretilecek
            prompt = s.get(variant)
            if not prompt:
                print(f"   [{variant}] ATLA (JSON'da {variant} yok)")
                continue

            if cfg.dry_run:
                need_state = "var" if required.exists() else "YOK!"
                print(f"   [{variant}] URETILECEK -> {out_name}  "
                      f"(girdi={required.name}:{need_state}, "
                      f"start={'evet' if start_arg else 'yok'}, end={'evet' if end_arg else 'yok'})")
                tally["planned"] += 1
                continue

            # --- GERCEK URETIM ---
            # RESUME: onceki koşu submit etmis ama poll'da olmus (progress'te submitted+vid_id)
            #   -> YENIDEN URETME; vid_id ile poll+download (video sunucuda duruyor).
            # KURAL: vid_id bir kez yazildiktan sonra ASLA silinmez. status ne olursa olsun
            #   (submitted / error+vid_id) vid_id varsa RESUME -> yeniden uretme, poll+download.
            prev = progress.get(out_name)
            resume_vid_id = prev.get("vid_id") if prev else None
            if resume_vid_id:
                print(f"   [{variant}] RESUME: vid_id={resume_vid_id} (prev={prev.get('status')}) "
                      f"-> poll+download (uretim yok)")

            if not resume_vid_id and not required.exists():
                print(f"   [{variant}] HATA: gerekli kare yok: {required}")
                progress[out_name] = {"status": "no_input_frame", "scene": label,
                                      "variant": variant}
                save_progress(cfg.progress_file, progress)
                tally["failed"] += 1
                continue

            # Pacing (provider'a gore): ilk uretimde bekleme yok; sonra sahne-arasi /
            # varyant-arasi random bekleme. RESUME'da (yalniz poll) bekleme YOK.
            if run_generated and not resume_vid_id:
                lo, hi = pace["variant"] if scene_generated else pace["scene"]
                gap = "varyant-arasi" if scene_generated else "sahne-arasi"
                core.sleep_between(lo, hi, why=f"{gap} ({cfg.provider})")
            if not resume_vid_id:
                run_generated = True
                scene_generated = True

            out_path = cfg.sink.local_path(out_name)   # adaptorun yazacagi (local staging) yol

            # on_submit: adaptor vid_id alir almaz cagirir -> progress'e {submitted, vid_id}.
            #   Proses SIGTERM/cokme/kesinti ile olse bile vid_id kayitli -> resume kurtarir.
            def _on_submit(vid_id, _out=out_name, _ak=adapter_key, _mt=spec.model_tag,
                           _v=variant, _l=label, _m=mode):
                progress[_out] = {"status": "submitted", "vid_id": vid_id, "provider": cfg.provider,
                                  "adapter": _ak, "model_tag": _mt, "variant": _v, "scene": _l, "mode": _m}
                save_progress(cfg.progress_file, progress)
                print(f"   [progress] submitted kaydedildi (vid_id={vid_id})")

            _dur, _dur_warn = _resolve_duration(s, spec.model_tag)
            if _dur_warn:
                print(f"   [UYARI-SURE] {_dur_warn}")
            job = core.Job(
                scene=s, variant=variant, prompt=prompt,
                start_image=start_arg, end_image=end_arg,
                out_path=out_path, duration=_dur,
                video_dir=str(cfg.video_dir),
                resolution=cfg.resolution,
                on_submit=_on_submit,
                resume_vid_id=resume_vid_id,
                prompt_optimizer=cfg.prompt_optimizer,
            )
            try:
                # S4 zinciri: moderasyonda retry/soften/fallback; digerlerini aynen yukari verir.
                produced, used_spec, s4meta = _generate_guarded(spec, job, cfg, mode)
                ref = cfg.sink.finalize(produced)      # asil hedefe koy (local=no-op, ileride Drive upload)
                rec = {
                    "status": "done", "provider": cfg.provider, "adapter": adapter_key,
                    "model_tag": used_spec.model_tag, "variant": variant, "scene": label,
                    "mode": mode, "file": str(ref),
                }
                if s4meta.get("softened"):             # sessiz sapma korumasi: iz birak
                    rec.update({"softened": True, "soften_attempt": s4meta["soften_attempt"],
                                "final_prompt": s4meta["final_prompt"]})
                    tally["softened"] += 1
                if s4meta.get("fallback_to"):
                    rec.update({"fallback_from": s4meta["fallback_from"], "fallback_to": s4meta["fallback_to"]})
                progress[out_name] = rec
                save_progress(cfg.progress_file, progress)
                tally["produced"] += 1
                extra = ""
                if s4meta.get("softened"):    extra = f"  [S4 SOFTENED #{s4meta['soften_attempt']}]"
                elif s4meta.get("fallback_to"): extra = f"  [S4 FALLBACK -> {s4meta['fallback_to']}]"
                elif s4meta.get("mod_retry"): extra = f"  [S4 retry #{s4meta['mod_retry']} gecti]"
                print(f"   [{variant}] OK -> {ref}{extra}")
            except SystemExit as e:
                recoverable = _record_failure(progress, out_name, status="failed",
                                              adapter=adapter_key, model_tag=spec.model_tag,
                                              variant=variant, scene=label, mode=mode, error=e)
                save_progress(cfg.progress_file, progress)
                if recoverable:
                    tally["submitted"] += 1
                    print(f"   [{variant}] BASARISIZ ama vid_id KAYITLI -> resume kurtarir: {e}")
                else:
                    tally["failed"] += 1
                    print(f"   [{variant}] BASARISIZ: {e}")
                if any(x in str(e) for x in ("401", "403", "nonce")):
                    print("\n!! Kimlik/nonce hatasi — duruyorum. Token yenileyip tekrar baslat "
                          "(kaldigi yerden devam eder; vid_id'li sahneler yeniden uretilmez).")
                    return _summary(cfg, tally, by_model)
            except NotImplementedError as e:
                print(f"   [{variant}] PARK (calisirken): {e}")
                tally["parked"] += 1
            except Exception as e:
                recoverable = _record_failure(progress, out_name, status="error",
                                              adapter=adapter_key, model_tag=spec.model_tag,
                                              variant=variant, scene=label, mode=mode, error=e)
                save_progress(cfg.progress_file, progress)
                if recoverable:
                    tally["submitted"] += 1
                    print(f"   [{variant}] HATA ama vid_id KAYITLI -> resume kurtarir: {e}")
                else:
                    tally["failed"] += 1
                    print(f"   [{variant}] BEKLENMEDIK HATA: {e}")

    return _summary(cfg, tally, by_model)


# ---------------------------------------------------------------------------
# M1 POOL YOLU — sirali prep (routing/skip/job-build) + paralel uretim (Pool)
#   concurrency=1 -> sirali akisa denk (regresyon). progress -> ProgressStore (tek-yazici, atomik).
# ---------------------------------------------------------------------------
def _run_pool(cfg, scenes, progress):
    store = ProgressStore(cfg.progress_file)
    pace = PACING.get(cfg.provider, {"scene": (20, 60)})
    pool = Pool(cfg.concurrency, store, pacing=pace["scene"])
    tally = {"produced": 0, "skipped": 0, "parked": 0, "failed": 0, "planned": 0,
             "submitted": 0, "softened": 0}
    by_model = {}
    start_only_ord = 0
    jobs = []
    print(f"  [POOL] concurrency={cfg.concurrency}  pacing={pace['scene']}  "
          f"(wait_for_queue ATLANIR; semaphore/ThreadPool birincil fren)")

    for s in scenes:
        idx = s.get("index", 0)
        label = s.get("label", f"scene_{idx:03d}")
        mode = s.get("frame_mode", "both")
        ordinal = start_only_ord
        if mode == "start_only":
            start_only_ord += 1
        if cfg.scenes_filter and idx not in cfg.scenes_filter:
            continue
        adapter_key = router.route(cfg.provider, mode, ordinal, cfg.start_model)
        spec = core.get(adapter_key)
        scene_dir = cfg.keyframes_dir / label
        first_img = scene_dir / "frame_first.jpg"
        last_img = scene_dir / "frame_last.jpg"
        if mode == "end_only":
            start_arg, end_arg, required = None, (str(last_img) if last_img.exists() else None), last_img
        else:
            start_arg = str(first_img) if first_img.exists() else None
            end_arg = str(last_img) if (mode == "both" and last_img.exists()) else None
            required = first_img

        for variant in cfg.variants:
            out_name = f"{label}_{spec.model_tag}_{variant}.mp4"
            by_model[spec.model_tag] = by_model.get(spec.model_tag, 0) + 1
            if cfg.sink.exists(out_name):
                print(f"   [{variant}] ATLA (zaten var): {out_name}")
                tally["skipped"] += 1
                continue
            if not spec.ready:
                store.update(out_name, {"status": "pending_no_adapter", "provider": cfg.provider,
                                        "adapter": adapter_key, "model_tag": spec.model_tag,
                                        "variant": variant, "scene": label, "mode": mode})
                tally["parked"] += 1
                continue
            prompt = s.get(variant)
            if not prompt:
                continue
            prev = progress.get(out_name)
            resume_vid_id = prev.get("vid_id") if prev else None
            if not resume_vid_id and not required.exists():
                store.update(out_name, {"status": "no_input_frame", "scene": label, "variant": variant})
                tally["failed"] += 1
                continue
            _dur, _dw = _resolve_duration(s, spec.model_tag)
            if _dw:
                print(f"   [UYARI-SURE] {_dw}")
            job = core.Job(
                scene=s, variant=variant, prompt=prompt,
                start_image=start_arg, end_image=end_arg,
                out_path=cfg.sink.local_path(out_name), duration=_dur,
                video_dir=str(cfg.video_dir), resolution=cfg.resolution,
                resume_vid_id=resume_vid_id, out_name=out_name,
                prompt_optimizer=cfg.prompt_optimizer,
                submit_meta={"provider": cfg.provider, "adapter": adapter_key, "model_tag": spec.model_tag,
                             "variant": variant, "scene": label, "mode": mode},
            )
            job._spec = spec
            job._mode = mode
            jobs.append(job)

    def produce(job):
        produced, used_spec, s4meta = _generate_guarded(job._spec, job, cfg, job._mode)
        ref = cfg.sink.finalize(produced)
        m = {"file": str(ref)}
        if s4meta.get("softened"):
            m.update(softened=True, soften_attempt=s4meta["soften_attempt"], final_prompt=s4meta["final_prompt"])
        if s4meta.get("fallback_to"):
            m.update(fallback_from=s4meta["fallback_from"], fallback_to=s4meta["fallback_to"])
        return ref, used_spec, m

    def on_result(r):
        if r.ok:
            tally["produced"] += 1
            extra = ""
            if r.meta and r.meta.get("softened"):
                tally["softened"] += 1
                extra = f"  [S4 SOFTENED #{r.meta['soften_attempt']}]"
            elif r.meta and r.meta.get("fallback_to"):
                extra = f"  [S4 FALLBACK -> {r.meta['fallback_to']}]"
            print(f"   [{r.job.variant}] OK -> {r.job.out_name}{extra}")
        else:
            rec = store.get(r.job.out_name)
            if rec and rec.get("vid_id"):
                tally["submitted"] += 1
                print(f"   [{r.job.variant}] BASARISIZ ama vid_id KAYITLI -> resume kurtarir: {r.error}")
            else:
                tally["failed"] += 1
                print(f"   [{r.job.variant}] BASARISIZ: {r.error}")

    print(f"  [POOL] {len(jobs)} is uretilecek")
    pool.run(jobs, produce, on_result)
    return _summary(cfg, tally, by_model)


# ---------------------------------------------------------------------------
# S4 — MODERASYON ZINCIRI (adaptorler dilsiz; siniflandirma + zincir burada)
#   retry x2 (ayni prompt) -> soften x3 (Claude, key varsa) -> (Firefly) model fallback -> error
# ---------------------------------------------------------------------------
_FIREFLY_FALLBACK = {"kling": "runway4.5", "runway": "kling2.5"}   # start_only carpraz


def _fallback_spec(spec, mode):
    """Firefly start_only icin model fallback (kling<->runway). both/end_only: yalniz Ray -> yok."""
    if mode != "start_only":
        return None
    key = _FIREFLY_FALLBACK.get(spec.model_tag)
    try:
        return core.get(key) if key else None
    except KeyError:
        return None


def _retry_structural(spec, job, first_exc, attempts=2, backoff=(3, 6)):
    """
    2400001 ('Content generation error, please regenerate') = SINIRLI + GURULTULU retry.
    Bugun 2400001'i 2 YAPISAL sebeple gorduk (2.3 both, 10s+1080 — ikisi de UPSTREAM onlendi: routing +
    accept-list/resolution). Kalanlar agirlikla TRANSIENT. AMA yarin 3. yapisal sebep cikarsa retry onu
    kor'lemesine denemesin: SAYILI (2) + her deneme UYARIR + tukenirse "muhtemelen YAPISAL" diye DURUR.
    (Eski step_hailuo 12dk x3 beklerdi — yapisal icin israf; burada birkac sn.)
    """
    last = first_exc
    for i in range(attempts):
        wait = backoff[min(i, len(backoff) - 1)]
        print(f"   [UYARI-2400001] structural/transient blip ({last}) -> {wait}s bekle, yeniden dene ({i + 1}/{attempts})...")
        time.sleep(wait)
        try:
            return spec.generate(job), spec, {"struct_retry": i + 1}
        except (Exception, SystemExit) as e:
            if moderation.classify(e) != "structural":
                raise                          # baska hataya donustuyse (transient degil) -> disari
            last = e
    raise RuntimeError(f"[2400001] {attempts} denemede gecmedi -> muhtemelen YAPISAL (transient degil), "
                       f"durduruldu: {last}")


def _generate_guarded(spec, job, cfg, mode):
    """
    spec.generate + S4 zinciri. Doner: (produced_path, used_spec, meta).
    Moderasyon DISI hata (structural/other) -> AYNEN yukari firlatir (runner except'leri ele alir).
    Moderasyon (Hailuo 2400002 / Firefly 451) -> zincir; tukenirse RuntimeError firlatir.
    """
    orig_prompt = job.prompt
    try:
        return spec.generate(job), spec, {}
    except (Exception, SystemExit) as e0:      # SystemExit(451) dahil; KeyboardInterrupt HARIC
        kind = moderation.classify(e0)
        if kind == "structural":               # 2400001 -> AYRI katman (S4 DEGIL): sinirli+gurultulu retry
            return _retry_structural(spec, job, e0)
        if kind != "moderation":
            raise                              # other -> disari (mevcut retry katmani)
        print(f"   [S4] MODERASYON ({type(e0).__name__}) -> zincir basliyor")

    # 1) retry x2 AYNI prompt (LLM gerekmez; moderasyon deterministik degil — scene_008 kaniti)
    for i in range(2):
        print(f"   [S4] retry {i + 1}/2 (ayni prompt)...")
        try:
            return spec.generate(job), spec, {"mod_retry": i + 1}
        except (Exception, SystemExit) as e:
            if moderation.classify(e) != "moderation":
                raise

    # 2) soften x3 (ANTHROPIC_API_KEY varsa; YOKSA temiz atla — zincir kirilmaz)
    if moderation.available():
        prior = []
        for i in range(3):
            try:
                soft = moderation.soften(orig_prompt, i + 1, prior)
            except Exception as se:
                print(f"   [S4] soften cagrisi hata ({se}) -> soften kademesi atlaniyor")
                break
            prior.append(soft)
            job.prompt = soft
            print(f"   [S4] soften {i + 1}/3 denendi")
            try:
                return spec.generate(job), spec, {"softened": True, "soften_attempt": i + 1,
                                                  "final_prompt": soft}
            except (Exception, SystemExit) as e:
                if moderation.classify(e) != "moderation":
                    job.prompt = orig_prompt
                    raise
        job.prompt = orig_prompt               # geri al
    else:
        print("   [S4] ANTHROPIC_API_KEY yok -> yumusatma ATLANDI (zincir surur)")

    # 3) model fallback (YALNIZ Firefly start_only: kling<->runway)
    if cfg.provider == "firefly":
        fb = _fallback_spec(spec, mode)
        if fb:
            print(f"   [S4] model fallback: {spec.model_tag} -> {fb.model_tag} (NOT: dosya adi/cozunurluk degisebilir)")
            job.prompt = orig_prompt
            try:
                return fb.generate(job), fb, {"fallback_from": spec.model_tag, "fallback_to": fb.model_tag}
            except (Exception, SystemExit) as e:
                print(f"   [S4] fallback {fb.model_tag} de basarisiz: {e}")

    # 4) zincir tukendi -> error+rapor
    raise RuntimeError(f"[S4] moderasyon zinciri tukendi (retry+soften+fallback): {orig_prompt[:60]}")


def _record_failure(progress, out_name, *, status, adapter, model_tag, variant, scene, mode, error, stage="poll"):
    """
    Hata kaydi — KURAL: vid_id ONCEDEN yazilmissa (submit OK olmus) KORU, ustune yazma.
    Boylece resume error/failed gorse bile vid_id ile poll+download dener (yeniden uretmez).
    status = neden basarisiz; vid_id = kurtarilabilir. Ikisi ayri bilgi, birbirini silmez.
    Doner: True => vid_id kayitli (kurtarilabilir/submitted-benzeri), False => gercek hata.
    """
    rec = {"status": status, "adapter": adapter, "model_tag": model_tag,
           "variant": variant, "scene": scene, "mode": mode, "error": str(error)}
    prev = progress.get(out_name)
    if prev and prev.get("vid_id"):
        rec["vid_id"] = prev["vid_id"]      # ASLA silinmez
        rec["stage"] = stage                # submit sonrasi -> poll/download asamasi
    progress[out_name] = rec
    return "vid_id" in rec


def _summary(cfg, tally, by_model):
    print("\n" + "=" * 64)
    if cfg.dry_run:
        print(f"DRY-RUN OZET: uretilecek={tally['planned']}  atlanacak={tally['skipped']}  "
              f"park={tally['parked']}")
    else:
        print(f"BITTI: uretildi={tally['produced']}  atlandi={tally['skipped']}  "
              f"park={tally['parked']}  submitted={tally['submitted']}  basarisiz={tally['failed']}")
        if tally['submitted']:
            print(f"  ⚠ submitted={tally['submitted']}: vid_id KAYITLI — resume poll+download ile alir "
                  f"(HATA DEGIL, kurtarilabilir).")
        if tally.get('softened'):
            print(f"  ⚠ softened={tally['softened']}: YUMUSATILMIS promptla uretildi (S4) — "
                  f"niyetten sapmis olabilir, progress'te final_prompt ile dogrula.")
    print(f"Model dagilimi (varyant-adet): {by_model}")
    print(f"Cikti: {cfg.sink.describe()}")
    print(f"Progress: {cfg.progress_file}")
    print("=" * 64)
    return tally
