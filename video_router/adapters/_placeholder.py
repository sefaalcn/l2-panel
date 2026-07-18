"""
_placeholder.py — henuz adaptorsuz modeller icin ortak sablon
=============================================================
Bir modeli GERCEK yapmak icin (F12'den curl yakaladiktan sonra) yapman gerekenler,
tek dosyada, 4 madde:

  1) ENDPOINT URL'leri        : generate (+ varsa upload/status) adresleri
  2) build_headers(job)       : token dosyasindan auth  (core.read_token("<model>_token.txt"))
                                Firefly ailesi firefly_token/arp/nonce paylasir;
                                Kling/Runway'in KENDI nonce'u olabilir -> kendi dosyasi.
  3) build_payload(job)       : curl govdesinin sablonu; start/end blob id + prompt buraya
  4) extract_result_url(resp) + extract_video_url(poll_json)
                                : sonuc URL'i nerede (header mi govde mi), video URL'i nerede

Sonra: _generate icini doldur (upload -> generate -> core.poll_until_done -> core.download_stream),
SPEC'te ready=True yap. Router tablosunda anahtar zaten var; baska yeri degistirmene gerek yok.
"""

from .. import core


def make_placeholder_generate(key, hint):
    def _generate(job: core.Job):
        raise NotImplementedError(
            f"'{key}' adaptoru henuz yok. F12'den curl yakalayip "
            f"video_router/adapters/{hint} dosyasini doldur (ready=True yap)."
        )
    return _generate
