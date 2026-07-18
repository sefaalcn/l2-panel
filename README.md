# L2.5 — Next.js Üretim Paneli

UI + API: **Next.js**. Üretim motoru: Python (`gemini_direct`, `video_router`, `l2_panel.l2_run`).

## Kurulum

```
npm install
pip install -r requirements.txt
```

## Geliştirme

```
npm run dev
```

http://127.0.0.1:8751

## Kullanım

1. Scenes JSON + keyframes ZIP sürükle-bırak → **Yükle**
2. Hailuo token / cookie / proje ID → **Başlat**
3. Python `l2_run` arka planda çalışır (`projects/<ad>/`)

## Vercel

`vercel --prod` — Next.js framework. Uzun koşu için paneli yerelde çalıştır (Vercel’de dosya + subprocess sınırlı).

## Python (worker)

```
python -m l2_panel.l2_run --help
python -m l2_panel.worker   # eski Drive worker (opsiyonel)
```
