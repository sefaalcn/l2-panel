# Pipeline — Python → TypeScript geçişi (TAMAMLANDI)

Üretim motoru tamamen TypeScript. Python kaynakları Faz 6'da silindi
(git geçmişinde duruyor: `aa1558f` ve öncesi).

## Mimari

```
Panel (/api/start)
  → detached: npx tsx src/worker/l2-run.ts
       → src/lib/pipeline/orchestrator.ts
            → engine: node (tek motor)
                 prompt: src/lib/pipeline/gemini
                 video : src/lib/pipeline/router → hailuo | firefly adaptörleri
```

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `GEMINI_API_KEY` | — | Prompt üretimi (zorunlu) |
| `ANTHROPIC_API_KEY` | — | S4 prompt yumuşatma (opsiyonel) |
| `L2_PIPELINE_ENGINE` | — | Kaldırıldı; motor her zaman `node` |

Promptlar: `prompts/gemini_system_prompt.txt` + `prompts/gemini_self_check.txt`
(eski `gemini_direct.py` içinden çıkarıldı — davranış aynı).

## Fazlar

- [x] **Faz 1** — TS orchestrator + Node worker (`src/worker/l2-run.ts`)
- [x] **Faz 2** — `gemini_direct` → `src/lib/pipeline/gemini/` (`L2_PIPELINE_ENGINE=node`)
- [x] **Faz 3** — `hailuo_pipeline` → `src/lib/pipeline/hailuo/` (`submitHailuoJob` — Faz 4 router bağlanacak)
- [x] **Faz 4** — `video_router` → `src/lib/pipeline/router/` (hailuo runner + pool + S4)
- [x] **Faz 5** — Firefly adaptörleri (ray3.14, ray3.14_end, kling2.5, runway4.5) TS'e taşındı.
      Drive sink Python'da da yazılmamıştı (LocalSink tek hedef) — TS'te de LocalSink; DriveSink ileride.
- [x] **Faz 6** — Python kaldırıldı: tüm `.py` kaynakları + `requirements.txt` silindi,
      promptlar `prompts/` klasörüne taşındı, `python` motoru koddan çıkarıldı.

## Doğrulama

`npx tsx scripts/smoke.ts` — API çağrısı yapmadan Faz 1-5 kontrolü:
routing eşlemeleri, adaptor registry, moderasyon sınıflandırma, dry-run planlama,
ProgressStore vid_id koruması. `python scripts/parity.py` (Python kaynakları silinmeden
önce çalıştırıldı) ile Hailuo `yy` imzası ve Firefly `stable_seed` birebir doğrulandı.

## Yerel gereksinimler

```bash
npm install
# ffmpeg PATH'te (yerel ffmpeg tercih edildi; wasm yavaş + bellek sınırlı)
```

## Test worker (elle)

```bash
npm run worker -- --project-path ./projects/MY_PROJECT --log ./projects/MY_PROJECT/.l2_run.log --variants v1
```
