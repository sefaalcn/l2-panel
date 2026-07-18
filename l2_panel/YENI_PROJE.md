# L2.5 — Yeni Proje Nasıl Eklenir

İki sistem **ayrı**: Scene Studio (bulut, edit + export) ↔ L2.5 (yerel, üret). Bağlantı yalnız **elle taşınan
dosyalar**. Bir projenin panelde **görünüp KOŞABİLMESİ** için klasör yapısı tam olmalı.

---

## Klasör yeri

**Local:** `L2_PROJECTS_ROOT/<Proje Adı>/` (env; varsayılan `./projects/`).

**Cloud (Drive):** `L2_DRIVE_ROOT_ID` kökünün altındaki klasörler. Örnek tek proje:
https://drive.google.com/drive/u/3/folders/1bEe6Mc90xuAa-VIGdIF2dXBoj2CuU18Q — kök ID, bu klasörün parent’ı olmalı.

Panel kök altındaki klasörleri tarar (`OLD/` ve `_l2_jobs` hariç). Klasörde en az bir **scenes JSON** ya da
**keyframes/** varsa proje listede görünür.

## İKİ SENARYO — "prompt'um var mı?" (preflight bunu `scenario: A/B` der)

### Senaryo A — prompt JSON HAZIR (gemini_direct önceden koşulmuş / elle yazılmış)
Panel yalnız **run_hailuo** çağırır. **GEMINI_API_KEY GEREKMEZ.**

| ZORUNLU | Dosya |
|---|---|
| Sahne şeması | `<ad>_scenes_manual.json` (Studio export) |
| Kareler | `keyframes/scene_XXX/frame_*.jpg` (Studio keyframes.zip) |
| **Prompt** | `<ad>_output/hailuo_prompts_claude.json` (hazır) |

### Senaryo B — prompt JSON YOK (Studio'dan yeni çıkmış ham proje)
Panel Başlat'ta **önce gemini_direct** (video analiz → prompt) **sonra run_hailuo**. Faz: *"Prompt üretiliyor"*.

| ZORUNLU | Dosya / girdi |
|---|---|
| Sahne şeması | `<ad>_scenes_manual.json` |
| Kareler | `keyframes/scene_XXX/frame_*.jpg` |
| **Kaynak video** | `<ad>.mp4` (gemini_direct Gemini'ye yükler) |
| **GEMINI_API_KEY** | Paneli başlatırken env (aşağıda) |

> **Prompt YOK ve video YOK** → prompt üretilemez. /preflight bunu **koşu-engelleyici** uyarı olarak der.

**keyframes/ yapısı** (her iki senaryoda, frame_mode'a göre):
```
keyframes/
  scene_001/ frame_first.jpg  frame_last.jpg   # both  -> ikisi
  scene_002/ frame_first.jpg                    # start_only -> yalnız first
  scene_003/ frame_last.jpg                     # end_only   -> yalnız last
```
> `both` sahnede `frame_last.jpg` eksikse /preflight uyarır (016/057 tipi sessiz düşme).
> `hailuo_router_videos/` + `hailuo_router_progress.json`: koşarken otomatik yaratılır.

## PANELDE girilir — DOSYA DEĞİL (sır hijyeni)

| Girdi | Nerede | Not |
|---|---|---|
| Hailuo **token, cookie, Proje ID** | Panel (Model=Hailuo altında) | Koşuda geçici `.l2_*`, **koşu sonu silinir** — `hailuo_token.txt` kirlenmez. Token her koşuda taze yapıştır (sık dolar). |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Paneli başlatırken **env** | Uzun ömürlü; `export ...` ile başlat. Dosya/log'a asla yazılmaz. |

## /preflight = eksik ne, panelde göster
Projeyi seçince panel şunu der: sahne sayısı, frame_mode dağılımı, **koşu-engelleyici uyarılar**
(keyframe yok / prompt üretilecek / frame_mode↔dosya uyuşmazlığı / desteklenmeyen süre). Rozetler:
`keyframes ✓/✗`, `prompt ✓/üretilecek`. **Eksik varsa Başlat'tan önce görürsün.**

---

## Somut örnek — "Traffic Rules"ı çalışır hale getirmek

**Şu an:** `German_scenes_manual.json` ✓ + `rules.mp4` ✓ · **keyframes/ YOK** · prompt YOK → koşamaz.

**Yapılacak:**
1. **Studio'dan keyframes.zip indir** → `Traffic Rules/keyframes/` altına aç
   (`keyframes/scene_001/frame_first.jpg` … 10 sahne, frame_mode'a göre first/last).
2. Paneli **GEMINI_API_KEY ile başlat** (prompt yok → gemini_direct koşacak; `rules.mp4` zaten var):
   ```
   GEMINI_API_KEY=<key> ANTHROPIC_API_KEY=<key> \
   python3 -m uvicorn l2_panel.app:app --host 127.0.0.1 --port 8751
   ```
3. Tarayıcı `http://127.0.0.1:8751`:
   - Model **Hailuo** → **token / cookie / Proje ID** yapıştır (token ✓ badge'i bekle)
   - **Üretilecek Proje** = Traffic Rules → rozetler `keyframes ✓ · prompt üretilecek`
   - **Başlat** → faz: *Prompt üretiliyor* → *Video üretiliyor* → *Bitti*
4. **Klasörü Aç** → `hailuo_router_videos/`.

> keyframes eklenmeden Başlat: /preflight "keyframes/ boş" + "scene_001: frame_first.jpg yok" uyarır — koşma.
