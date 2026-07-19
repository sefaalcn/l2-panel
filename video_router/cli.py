"""
cli.py — run_firefly / run_hailuo icin ortak arguman + yol cozumu
=================================================================
--path'ten yollari turetir (batch_ray314 / hailuo_pipeline ile ayni mantik):
  <video>/<video>_output/hailuo_prompts_claude.json   -> promptlar
  <video>/keyframes/<label>/frame_first.jpg|frame_last.jpg

Cikti/progress SAGLAYICIYA GORE AYRI (ikisi ayni anda calisabilsin):
  firefly -> firefly_videos/        + firefly_progress.json
  hailuo  -> hailuo_router_videos/  + hailuo_router_progress.json
"""

import argparse
import pathlib
import sys

from . import runner


def _resolve_paths(provider, video_dir, keyframes_source=None):
    video_dir = pathlib.Path(video_dir).expanduser()
    name = video_dir.name
    prompts = video_dir / f"{name}_output" / "hailuo_prompts_claude.json"
    # Kaynak: bayrak > .l2_keyframes_source > original
    source = keyframes_source
    if source not in ("original", "swapped"):
        pref = video_dir / ".l2_keyframes_source"
        if pref.exists():
            source = pref.read_text(encoding="utf-8").strip().lower()
        else:
            source = "original"
    if source == "swapped":
        keyframes = video_dir / "keyframes_swapped"
        if not keyframes.exists():
            keyframes = video_dir / "keyframes"  # geriye donuk: klasor yoksa original
    else:
        keyframes = video_dir / "keyframes"
    if provider == "firefly":
        out = video_dir / "firefly_videos"
        prog = video_dir / "firefly_progress.json"
    else:
        out = video_dir / "hailuo_router_videos"
        prog = video_dir / "hailuo_router_progress.json"
    return video_dir, prompts, keyframes, out, prog


def main(provider: str):
    # S1: arka plan (> redirect) kosularinda stdout blok-buffer olur -> ilerleme log'da
    # gorunmez. Satir-buffer'a al ki firefly_gen dahil tum modul print'leri aninda aksin.
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass  # eski Python / tty degil: sessiz gec
    ap = argparse.ArgumentParser(
        description=f"{provider} pipeline (router+adaptor)")
    ap.add_argument("--path", required=True, help="video klasoru (icinde <ad>_output/ + keyframes/)")
    ap.add_argument("--variants", default=None,
                    help="orn: v1,v3  (verilmezse interaktif sorar)")
    ap.add_argument("--start-model", default=None, dest="start_model",
                    choices=["kling", "runway", "alternate"],
                    help="firefly start_only modeli (verilmezse firefly'da sorar; varsayilan kling)")
    ap.add_argument("--scenes", default=None, help="orn: 1-3,7  (verilmezse hepsi)")
    ap.add_argument("--dry-run", action="store_true", help="kredisiz plan; hic API cagirmaz")
    ap.add_argument("--duration", type=int, default=5)
    ap.add_argument("--resolution", default=None, choices=["720p", "1080p"],
                    help="firefly cozunurluk (verilmezse model varsayilani: ray314=720p, kling=1080p, runway=720p). "
                         "720p promo'da SINIRSIZ; 1080p KREDILI.")
    ap.add_argument("--concurrency", type=int, default=None,
                    help="M1 Pool: verilmezse SIRALI (mevcut). 1=Pool regresyon (sirali denk), 2+=paralel uretim.")
    ap.add_argument("--no-optimizer", dest="prompt_optimizer", action="store_false",
                    help="Hailuo prompt optimizer'i KAPAT (verbatim, useOriginPrompt=True). Varsayilan: acik (optimize).")
    ap.add_argument("--keyframes-source", default=None, choices=["original", "swapped"],
                    help="keyframes/ (original) veya keyframes_swapped/ (swapped). "
                         "Verilmezse .l2_keyframes_source veya original.")
    ap.set_defaults(prompt_optimizer=True)
    args = ap.parse_args()

    video_dir, prompts, keyframes, out, prog = _resolve_paths(
        provider, args.path, args.keyframes_source)
    print(f"[cli] keyframes_dir={keyframes}")

    # Varyant: bayrak varsa onu kullan (otomasyon), yoksa interaktif sor.
    if args.variants:
        variants = runner.parse_variants_flag(args.variants)
    else:
        variants = runner.select_variants_interactive()

    # start_only modeli SADECE firefly icin anlamli. Bayrak varsa kullan; yoksa
    # firefly'da video basinda BIR KEZ sor (varyant sorusuyla ayni yer). hailuo'da yok say.
    if provider == "firefly":
        start_model = args.start_model or runner.select_start_model_interactive()
    else:
        start_model = "kling"   # hailuo start_only -> hailuo2.3; deger kullanilmaz

    scenes_filter = runner.parse_scenes_arg(args.scenes) if args.scenes else None

    # M1 Stage 2c: Hailuo DEFAULT concurrency=2 (olculdu: peak_gen=2, ~2x paralellik, progress guvenli).
    # Firefly SIRALI kalir (Adobe tek-video). --concurrency ile ez (0/1=sirali-denk, 2+=paralel).
    concurrency = args.concurrency
    if concurrency is None and provider == "hailuo":
        concurrency = 2
    if concurrency is not None and concurrency <= 1 and provider == "hailuo":
        concurrency = 1   # 1 = Pool regresyon yolu; 0/negatif -> 1

    # Cikti hedefi: simdilik LocalSink. Ileride --sink drive ile DriveSink secilebilir.
    from . import core
    sink = core.LocalSink(out)

    cfg = runner.PipelineConfig(
        provider=provider,
        prompts_json=prompts,
        keyframes_dir=keyframes,
        video_dir=video_dir,
        sink=sink,
        progress_file=prog,
        variants=variants,
        start_model=start_model,
        scenes_filter=scenes_filter,
        dry_run=args.dry_run,
        duration=args.duration,
        resolution=args.resolution,
        concurrency=concurrency,
        prompt_optimizer=args.prompt_optimizer,
    )
    runner.run(cfg)
