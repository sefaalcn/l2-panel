"""
pool.py — M1 iş havuzu (AYRI KATMAN: runner + L2.5 kullanır).
================================================================================
Tasarım (A): adaptör `submit()` BÜTÜN olarak worker thread'de koşar (upload→generate→poll→download).
Poll-bekleme örtüşür → üretim PARALEL (B testi: ~1.6-2×). concurrency=1 → sıralıya denk (regresyon).

- concurrency  : eşzamanlılık tavanı. Firefly=1, Hailuo=2-4 (ölçülen). ThreadPool(N) = BİRİNCİL fren.
                 (wait_for_queue Pool'da ATLANIR — kendi işlerimizi sayıp self-deadlock yapardı.)
- store        : ProgressStore (tek-yazıcı) — on_submit/done/failed KİLİTLİ + ATOMİK.
- _gate        : GLOBAL submit kapısı (pacing) — son generate'ten ≥rastgele(20-60)s geçmeden yenisi gitmez;
                 worker'lar tek tek geçer (yığılma/bot koruması). Adaptör generate'ten önce job.pre_generate() çağırır.
- on_submit    : iş-başına — submit OK olunca vid_id ANINDA store'a (kesintide resume kurtarır).
- hata izolasyonu: patlayan iş JobResult(ok=False) + record_failure (vid_id korunur); havuz DEVAM.
- sırasız biter; çağıran (runner) index'e göre sıralar.
"""

import time
import random
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Optional, Callable


@dataclass
class JobResult:
    job: object
    ok: bool
    path: object = None
    error: Optional[str] = None
    used_spec: object = None
    meta: Optional[dict] = None


class Pool:
    def __init__(self, concurrency: int, store, pacing=(20, 60)):
        self.concurrency = max(1, int(concurrency))
        self.store = store
        self.pacing = pacing
        self._gate_lock = threading.Lock()
        self._last_generate = 0.0

    def _gate(self):
        """GLOBAL submit kapısı: son generate'ten ≥rastgele(pacing)s geçene dek bekle. Kilitli = tek tek geçiş."""
        lo, hi = self.pacing
        with self._gate_lock:
            if hi and hi > 0:
                wait = random.randint(lo, hi)
                if self._last_generate:
                    elapsed = time.time() - self._last_generate
                    if elapsed < wait:
                        time.sleep(wait - elapsed)
            self._last_generate = time.time()

    def _work(self, job, produce):
        # Pool kancaları (adaptör bunları okur)
        job.skip_queue_gate = True
        job.pre_generate = self._gate
        job.on_submit = lambda vid, j=job: self.store.set_submitted(j.out_name, vid, j.submit_meta or {})
        base = dict(job.submit_meta or {})
        try:
            path, used_spec, meta = produce(job)
            rec = dict(base); rec["status"] = "done"
            if meta:                       # file/softened/fallback... duz-merge -> sirali done kaydiyla ayni
                rec.update(meta)
            self.store.update(job.out_name, rec)
            return JobResult(job, True, path, None, used_spec, meta)
        except (Exception, SystemExit) as e:
            rec = dict(base); rec["status"] = "error"; rec["error"] = str(e)
            self.store.record_failure(job.out_name, rec)   # vid_id KORUNUR
            return JobResult(job, False, None, str(e))

    def run(self, jobs, produce, on_result=None):
        """jobs listesini işle. produce(job)->(path,spec,meta) [S4 dahil]. Sonuç listesi (sırasız biter)."""
        results = []
        if self.concurrency == 1:
            # SIRALI (regresyon): ThreadPool overhead'siz, aynı work mantığı.
            for job in jobs:
                r = self._work(job, produce)
                if on_result:
                    on_result(r)
                results.append(r)
            return results
        with ThreadPoolExecutor(max_workers=self.concurrency) as ex:
            futs = {ex.submit(self._work, j, produce): j for j in jobs}
            for f in as_completed(futs):
                r = f.result()
                if on_result:
                    on_result(r)        # ANA thread (çağıranın kilit derdi yok)
                results.append(r)
        return results
