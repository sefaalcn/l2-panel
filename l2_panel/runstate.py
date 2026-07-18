"""
l2_panel/runstate.py — restart-dayanıklı TEK-KOŞU kilidi + faz durumu.
================================================================================
Global runstate dosyası (panel klasöründe). PID canlı kontrolü ile: panel çöküp açılsa bile
arka planda hâlâ koşan wrapper'ı tanır. Atomik yazma (PID-tmp) — iki yazıcı bozmaz.
"""
import os
import json
import pathlib

PANEL_DIR = pathlib.Path(__file__).resolve().parent
RUNSTATE = PANEL_DIR / ".l2_active_run.json"


def _atomic_write(path, data):
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(path))


def read_runstate():
    if RUNSTATE.exists():
        try:
            return json.loads(RUNSTATE.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def write_runstate(d):
    _atomic_write(RUNSTATE, d)


def clear_runstate():
    try:
        RUNSTATE.unlink()
    except OSError:
        pass


def pid_alive(pid):
    """os.kill(pid,0) -> canlı mı. Panel restart'ından bağımsız (dosya kalıcı)."""
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def active_run():
    """CANLI bir koşu varsa runstate döner; yoksa None. Stale (PID ölü) runstate'i TEMİZLER."""
    rs = read_runstate()
    if rs and pid_alive(rs.get("pid")):
        return rs
    if rs:
        clear_runstate()          # stale -> temizle (kilit serbest)
    return None
