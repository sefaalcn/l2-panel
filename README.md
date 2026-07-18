# L2.5 — Üretim Paneli

Sürükle-bırak ile proje yükle → Hailuo üret. Drive yok.

## Yerel çalıştır

```
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8751
```

Tarayıcı: http://127.0.0.1:8751

## Kullanım

1. Panelde **Proje yükle** alanına bırak:
   - `*_scenes_manual.json`
   - `*_keyframes.zip` (içinde `keyframes/scene_XXX/frame_*.jpg`)
   - isteğe bağlı `.mp4`
2. **Yükle** → proje listede görünür
3. Hailuo token / cookie / proje ID → **Başlat**

Studio’daki **L2.5'e gönder** tuşu da aynı `/ingest` endpoint’ine gider (`L2_PANEL_URL`).

## Klasör

Yüklenenler: `L2_PROJECTS_ROOT` (varsayılan `./projects/<proje>/`).

## Vercel notu

Canlı UI için Vercel kullanılabilir; uzun Hailuo koşusu ve kalıcı dosya için paneli **yerelde** (veya worker’lı makinede) çalıştır.
