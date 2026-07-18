# L2.5 — Üretim Paneli (Deploy)

Yerel veya **Vercel (panel) + Google Drive (dosya) + Worker (üretim)**.

Üretim motoru aynıdır: `gemini_direct` → prompt, `video_router.run_hailuo` → video (v1/v2…).
Değişen: dosya I/O (Drive) ve panel hosting (Vercel).

## Studio → L2.5 (tek tuş)

Scene Studio Export menüsünde **L2.5'e gönder**:
scenes JSON + keyframes ZIP (+ video) → `POST /ingest` → Drive veya yerel `projects/`.

Studio `.env`:
```
L2_PANEL_URL=http://127.0.0.1:8751
L2_INGEST_TOKEN=aynı-secret
```

L2 `.env`: `L2_INGEST_TOKEN` aynı değer. Cloud'da Drive root + service account gerekir.

## Mimari

| Katman | Ne yapar |
|---|---|
| **Vercel** (`app.py`) | Panel UI + API (projeler, preflight, start→kuyruk, progress) |
| **Google Drive** | Proje klasörleri (mp4, scenes, keyframes, çıktı videolar) |
| **Worker** (`python -m l2_panel.worker`) | Job alır → Drive indir → `l2_run` → çıktı yükle |

`L2_RUNTIME=local` → eski davranış (yerel disk + subprocess), Drive/worker gerekmez.

## Kurulum

```bash
pip install -r requirements.txt
cp .env.example .env
# .env doldur
```

### Google Drive

1. Google Cloud’da service account oluştur, Drive API aç.
2. JSON anahtarı indir → `service-account.json` (veya JSON’u `GOOGLE_SERVICE_ACCOUNT_JSON` env’e yapıştır).
3. Drive’da **projelerin kök klasörünü** service account e-postasıyla paylaş (Editor).
4. Kök klasör ID’sini `L2_DRIVE_ROOT_ID` yap.
   - Tek proje klasörü (ör. [ice_cream_truck](https://drive.google.com/drive/u/3/folders/1bEe6Mc90xuAa-VIGdIF2dXBoj2CuU18Q)) değil; onun **üst** klasörü.
5. Her proje alt klasör:

```
<Kök>/
  ice_cream_truck/
    *.mp4
    *_scenes_manual.json
    keyframes/...
    <ad>_output/hailuo_prompts_claude.json   # opsiyonel (Senaryo A)
  _l2_jobs/   # otomatik oluşur (kuyruk)
```

### Vercel (panel)

1. Repo’yu Vercel’e bağla ([FastAPI docs](https://vercel.com/docs/frameworks/backend/fastapi)).
2. Environment Variables:

| Key | Değer |
|---|---|
| `L2_RUNTIME` | `cloud` |
| `L2_DRIVE_ROOT_ID` | Drive kök klasör ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | service account JSON (tek satır) |
| `GEMINI_API_KEY` | (opsiyonel; panelden de girilir) |
| `ANTHROPIC_API_KEY` | (opsiyonel) |

3. Deploy. Panel URL’inde UI açılır; `/health` → `runtime: cloud`.

### Worker (zorunlu — uzun koşular)

Vercel job’u kuyruğa yazar; **worker olmadan video üretilmez**. Docker yok:

```bash
# Aynı makinede veya VPS’te, repo kökünde:
set L2_RUNTIME=cloud
set L2_DRIVE_ROOT_ID=...
set GOOGLE_APPLICATION_CREDENTIALS=.\service-account.json
set GEMINI_API_KEY=...
python -m l2_panel.worker
```

Worker sürekli açık kalmalı (PC açık / VPS process).

## Yerel geliştirme (Drive’sız)

```bash
set L2_RUNTIME=local
set L2_PROJECTS_ROOT=C:\path\to\videos
python -m uvicorn app:app --host 127.0.0.1 --port 8751
```

## Ne var

| Yol | Görev |
|---|---|
| `app.py` | Vercel/uvicorn giriş |
| `l2_panel/` | Panel API, Drive, jobs, worker, l2_run |
| `video_router/` | run_hailuo, Pool, adaptörler |
| `gemini_direct.py` | Prompt üretimi |
| `hailuo_pipeline.py` | Hailuo API |
| `firefly_gen.py` | Adaptör import zinciri |

Proje klasör kuralları: [`l2_panel/YENI_PROJE.md`](l2_panel/YENI_PROJE.md).
