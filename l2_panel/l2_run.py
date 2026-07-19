"""
l2_panel/l2_run.py — L2.5 KOŞU WRAPPER'ı (detached subprocess'in KENDİSİ).
================================================================================
Panel/worker bunu spawn eder → panel kapansa bile yaşar (panel = izleyici).
Görev:
  1. runstate faz: basliyor → prompt_uretiliyor → video_uretiliyor → bitti/hata
  2. gemini_direct (prompt yoksa) → run_hailuo (Pool). Token/cookie env-override'dan (2a).
  3. finally + SIGTERM: token dosyalarını (.l2_token/.l2_cookie) SİL → gerçek hailuo_token.txt kirlenmez.
     (SIGKILL finally'yi atlar → panel /start'ta stale temizler = çift emniyet.)
Env (panel'den): HAILUO_TOKEN_FILE, HAILUO_COOKIE_FILE, GEMINI_API_KEY, ANTHROPIC_API_KEY.
Key/token LOG'A YAZILMAZ (yalnız komut + faz loglanır).
"""
import os
import sys
import time
import signal
import argparse
import subprocess
import pathlib

from l2_panel.config import CODE_ROOT
from l2_panel import runstate

PROJECT_ROOT = str(CODE_ROOT)


def _update(status, **extra):
    rs = runstate.read_runstate() or {}
    rs.update(status=status, pid=os.getpid(), updated_at=time.time(), **extra)
    runstate.write_runstate(rs)


def _cleanup_tokens():
    # Panel'in yazdigi gecici kimlik dosyalari (.l2_token/.l2_cookie/.l2_project) — hepsi env'de isaretli.
    for env_var in ("HAILUO_TOKEN_FILE", "HAILUO_COOKIE_FILE", "HAILUO_PROJECT_FILE"):
        f = os.environ.get(env_var)
        if f and os.path.exists(f):
            try:
                os.remove(f)
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-path", required=True)
    ap.add_argument("--provider", default="hailuo")
    ap.add_argument("--variants", default="v1")
    ap.add_argument("--concurrency", default=None)
    ap.add_argument("--scenes", default=None)         # opsiyonel sahne filtresi -> run_hailuo --scenes
    ap.add_argument("--no-optimizer", action="store_true")
    ap.add_argument("--keyframes-source", default="original",
                    choices=["original", "swapped"],
                    help="keyframes/ (original) veya keyframes_swapped/ (swapped)")
    ap.add_argument("--log", required=True)
    args = ap.parse_args()

    proj = pathlib.Path(args.project_path)
    # Tercihi proje klasörüne yaz (gemini_direct / cli dosyadan da okuyabilir)
    (proj / ".l2_keyframes_source").write_text(args.keyframes_source, encoding="utf-8")
    logf = open(args.log, "a", buffering=1, encoding="utf-8")
    py = sys.executable

    # SIGTERM (/stop) -> SystemExit fırlat ki FINALLY çalışsın (token silinsin)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

    def run(cmd, phase):
        _update(phase, project=proj.name)
        logf.write(f"\n=== {phase}: {' '.join(cmd)} ===\n"); logf.flush()
        r = subprocess.run(cmd, stdout=logf, stderr=subprocess.STDOUT,
                           stdin=subprocess.DEVNULL, cwd=PROJECT_ROOT, env=os.environ)
        return r.returncode

    try:
        _update("basliyor", project=proj.name, started_at=time.time())
        # 1) PROMPT (yoksa) — uzun sürer, runstate 'prompt_uretiliyor' göstersin
        prompts = proj / f"{proj.name}_output" / "hailuo_prompts_claude.json"
        if not prompts.exists():
            gcmd = [py, "gemini_direct.py", "--path", str(proj),
                    "--keyframes-source", args.keyframes_source]
            if args.scenes:
                gcmd += ["--scenes", args.scenes]     # yalniz test sahnelerini uret (format: 1-2 / N)
            rc = run(gcmd, "prompt_uretiliyor")
            if rc != 0:
                _update("hata", error=f"gemini_direct rc={rc}"); return
        # 2) VIDEO — Pool
        cmd = [py, "-u", "-m", "video_router.run_hailuo", "--path", str(proj),
               "--variants", args.variants, "--keyframes-source", args.keyframes_source]
        if args.concurrency:
            cmd += ["--concurrency", str(args.concurrency)]
        # Proje ID: panel .l2_project.txt yazar + HAILUO_PROJECT_FILE env verir (token/cookie ile ayni desen).
        if args.scenes:
            cmd += ["--scenes", args.scenes]
        if args.no_optimizer:
            cmd += ["--no-optimizer"]
        rc = run(cmd, "video_uretiliyor")
        _update("bitti" if rc == 0 else "hata", rc=rc)   # NORMAL sonuc — wrapper'in kendi ciktisi
    # SIGTERM (/stop) yolunda runstate'e YAZMA: tek sahip = PANEL (/stop temizler). Cift-yazici yaris olurdu.
    # SystemExit finally'ye duser (token silinir), runstate'e dokunulmaz.
    finally:
        _cleanup_tokens()        # token dosyalarını sil (başarı/çökme/stop) — gerçek dosya kirlenmez
        logf.close()


if __name__ == "__main__":
    main()
