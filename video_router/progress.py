"""
progress.py — progress kalıcılığı (M1 Stage 1: atomik yazma + tek-yazıcı).
================================================================================
AYRI KATMAN: runner, Pool ve L2.5  hepsi bunu kullanır (kuyruğu iki kez inşa etme).

- save_progress: ATOMIK (tmp + os.replace) → yazma sırasında crash/kesinti dosyayı bozmaz, vid_id kaybı YOK.
- ProgressStore: TEK YAZICI. Paralel worker'lar update()/set_submitted() çağırır; kilit read-merge-write'i
  serileştirir → iki iş aynı anda yazsa bile kayıt kaybolmaz. save_progress atomik olduğu için crash-safe.
  KURAL (bugünden): vid_id bir kez yazıldıktan sonra ASLA silinmez (set_submitted koruma yapar).
"""

import os
import json
import threading


def load_progress(path):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_progress(path, data):
    # ATOMIK: tmp'ye yaz + os.replace (POSIX rename, ayni fs'de atomik). Crash'te GERCEK dosya bozulmaz.
    # tmp adi PROSES-BASINA benzersiz (.{pid}.tmp): ProgressStore kilidi proses-ICI; iki AYRI proses
    # (runner + L2.5, ya da iki kosu) sabit tmp'ye yazsa os.replace bozuk yayinlardi. PID son eki ile
    # her proses kendi tmp'sini yazip atomik yayinlar -> sonuncusu kazanir, BOZUK degil. (Orphan .tmp
    # proses-basina en fazla 1 -> sinirli.)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(str(tmp), str(path))
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


class ProgressStore:
    """TEK YAZICI: tum guncellemeler kilit altinda + atomik diske yazilir. Paralel-guvenli."""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._data = load_progress(path)

    def update(self, key, record):
        """key -> record (tam kayit). Kilitli + atomik. vid_id koruma cagirana ait (asagidaki yardimcilar)."""
        with self._lock:
            self._data[key] = record
            save_progress(self.path, self._data)

    def set_submitted(self, key, vid_id, meta):
        """submit OK -> {status:submitted, vid_id,...}. vid_id HEMEN kalici (kesintide kurtarma)."""
        with self._lock:
            rec = dict(meta or {})
            rec["status"] = "submitted"
            rec["vid_id"] = vid_id
            self._data[key] = rec
            save_progress(self.path, self._data)

    def record_failure(self, key, record):
        """hata kaydi — ONCEKI vid_id KORUNUR (asla silinmez). record status/error/stage tasir."""
        with self._lock:
            prev = self._data.get(key)
            if prev and prev.get("vid_id") and not record.get("vid_id"):
                record = {**record, "vid_id": prev["vid_id"]}
            self._data[key] = record
            save_progress(self.path, self._data)

    def get(self, key):
        with self._lock:
            return self._data.get(key)

    def snapshot(self):
        with self._lock:
            return dict(self._data)
