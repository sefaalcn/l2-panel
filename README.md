# L2.5 — Next.js Üretim Paneli

UI + API + üretim motoru: **tamamı TypeScript** (Next.js panel + `src/lib/pipeline` motor).
Python bağımlılığı Faz 6'da kaldırıldı; eski Python kaynakları git geçmişinde (`aa1558f` ve öncesi).

## Kurulum

```
npm install
```

Gereksinim: Node 18+, PATH'te **ffmpeg** (video sıkıştırma için).

## Geliştirme

```
npm run dev
```

http://127.0.0.1:3000

## Kullanım

1. Scenes JSON + keyframes ZIP sürükle-bırak → **Yükle**
2. Hailuo token / cookie / proje ID → **Başlat**
3. TS worker arka planda çalışır (`npx tsx src/worker/l2-run.ts`, log: `projects/<ad>/.l2_run.log`)

## Worker (elle)

```
npm run worker -- --project-path ./projects/MY_PROJECT --log ./projects/MY_PROJECT/.l2_run.log --variants v1
```

## Doğrulama

```
npx tsx scripts/smoke.ts   # routing / registry / dry-run / progress testleri (API çağrısı yok)
```

## Vercel

`vercel --prod` — Next.js framework. Uzun koşu için paneli yerelde çalıştır (Vercel'de dosya + subprocess sınırlı).

## Mimari

Ayrıntı: `PIPELINE.md`
