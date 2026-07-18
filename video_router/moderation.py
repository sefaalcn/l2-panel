"""
moderation.py — S4: moderasyon hata sinifi + prompt yumusatma
=============================================================
Adaptorler DILSIZ: sadece hata kodunu yukari verirler. Siniflandirma + zincir RUNNER'da.

classify(exc) -> "moderation" | "structural" | "other"
  Hailuo 2400002 (Community Guidelines) -> moderation  (zincir calissin)
  Hailuo 2400001 (yapisal, RQ2: 2.3 both reddi) -> structural  (yumusatma BOSA gider)
  Firefly HTTP 451 -> moderation
  ag/SSL/403/401/timeout/diger -> other  (mevcut retry katmani; zincir tetiklenmesin)

soften(original, attempt, prior) -> str
  master.py/voiceover_script_gen ile AYNI Claude tesisati (OPUS_MODEL, ANTHROPIC_API_KEY).
  Dil/kultur dosyalari YUKLENMEZ — yumusatma kisa/teknik is.
"""

import os

OPUS_MODEL = "claude-opus-4-8"      # voiceover_script_gen.py ile ayni


def classify(exc) -> str:
    """Hata nesnesini/mesajini sinifla. 2400001 ONCE (2400002'den ayri tutulmali)."""
    s = str(exc)
    if "2400001" in s:
        return "structural"                  # Hailuo yapisal -> yumusatma tetikleme
    if "2400002" in s:
        return "moderation"                  # Hailuo Community Guidelines
    # Firefly 451 = moderation. 401/403 (auth/cozunurluk) DEGIL -> yalniz 451'e bak.
    if ("HTTP 451" in s) or ("451 Client Error" in s):
        return "moderation"
    return "other"                           # ag/SSL/403/401/timeout/diger


def available() -> bool:
    """Yumusatma icin ANTHROPIC_API_KEY var mi? (yoksa zincir soften kademesini atlar)"""
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


_SYSTEM = (
    "Bir video-uretim promptu icerik moderasyonuna takildi. Gorevin: AYNI sahneyi ve AYNI eylemi "
    "koruyarak, moderasyona takilabilecek terimleri (tibbi: igne/asi/enjeksiyon; siddet; vb.) "
    "yumusatmak. Kamera/aksiyon/stil etiketlerini koru. Her denemede biraz DAHA yumusak yaz. "
    "SADECE yeni promptu don, aciklama yazma."
)


def soften(original: str, attempt: int, prior: list) -> str:
    """Claude ile promptu yumusat. attempt=1..3; prior=onceki yumusatilmis denemeler."""
    import anthropic
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY yok — yumusatma yapilamaz.")
    prior_txt = ""
    if prior:
        prior_txt = "\n\nBu denemeler de takildi, daha da yumusak yaz:\n" + "\n".join(
            f"  - {p}" for p in prior)
    user = (f"Orijinal prompt (takildi):\n{original}{prior_txt}\n\n"
            f"Yumusatma denemesi #{attempt}. Yeni promptu yaz:")
    client = anthropic.Anthropic(api_key=key)
    r = client.messages.create(
        model=OPUS_MODEL, max_tokens=1000, system=_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    return r.content[0].text.strip()
