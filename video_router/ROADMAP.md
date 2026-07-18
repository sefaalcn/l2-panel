# video_router — Yol Haritası

## ⚙️ ÇALIŞMA KURALI (her oturumda geçerli — en üstte, önce bunu oku)

**Her adım test edilmeden bir sonrakine geçilmez.** Proje aceleye getirilmeden, anlaşılarak tamamlanır.

**Test şu üçünü kapsar:**
1. **Mutlu yol** — beklenen girdi → beklenen çıktı.
2. **Hata yolu** — patladığında ne oluyor, durum korunuyor mu? (except'in vid_id'yi ezmesi bug'ı
   buradan çıktı; 8/8 mutlu-yol testi onu KAÇIRMIŞTI.)
3. **Regresyon** — eski davranış bozulmamış mı? (örn. 403 hâlâ anında duruyor mu.)

**Sıra:** stub/kota harcamayan test → **tek sahnede canlı test** → toplu koşu. Hiçbir adım atlanmaz.

**Gerçek koşu öncesi:** dry-run HER ZAMAN `--dry-run` bayrağıyla. Bayrak yoksa komut GÖNDERİLMEZ.
(Bir kez unutuldu → 2 dk gerçek üretim koştu.)

**Şüphe varsa ÖLÇ, tahmin etme.** Ölçüm 3 kez ilk tahminin TERSİNİ gösterdi: 403 = çözünürlük
(Arkose değil), retry'da bug yok (derinlik yetmemişti), scene_050 poll'da öldü (submit değil).

**"DOĞRULANDI" = ÇIKTI ÖLÇÜLDÜ, HTTP 200 DEĞİL.** (Bugün 3. kez aynı hata: ray314_end, kling/runway,
end_only — hepsi "video üretti" diye doğrulanmış sayıldı, ama çıktı ölçülmemişti; end_only'nin frame_last'ı
BAŞLANGIÇ olarak koyduğu ancak frame-MSE ile ortaya çıktı.) Bir adaptör, **çıktısı ölçülmeden** doğrulanmış
sayılmaz: **frame karşılaştırma (MSE), süre (ffprobe), çözünürlük** ölçülecek. HTTP 200 / dosya indi YETMEZ.

## Uzun vadeli hedef: Uçtan uca otomasyon zinciri

**Nihai vizyon:** Scene Studio'dan çıkan keyframe'ler + `scenes.json` → otomatik prompt
üretimi (Gemini/Claude; v1/v2/v3) → `video_router` ile çok-modelli video üretimi →
hepsi **birkaç tuşla / tek orchestrator komutuyla** çalışsın.

## Mimari ilke: bağımsız katmanlar + üst orchestrator

Her katman **kendi başına çalışabilen bağımsız bir modül** olacak; en üstte bir
orchestrator bunları zincirleyecek. Katmanlar arası sözleşme = dosyalar
(`keyframes/`, `scenes.json`, `<ad>_output/hailuo_prompts_claude.json`, çıktı klasörleri).

```
[1] Studio besleme      keyframes/ + scenes.json  (Scene Studio çıktısı)
        │
[2] Prompt üretimi      Gemini/Claude -> v1/v2/v3 + frame_mode  (gemini_direct.py bu katmanın çekirdeği)
        │
[3] Video üretimi       video_router  (router + adaptör; Firefly/Hailuo, çok-model)   ← MEVCUT
        │
[*] Orchestrator        yukaridaki 3 katmani tek komutla zincirler
```

## İnşa sırası — KATMAN KATMAN (aceleye getirilmeyecek)

1. **ÖNCE `video_router` sağlamlaşsın** (mevcut aşama).
   - [x] Firefly: Ray3.14 (both) — HAZIR, gerçek üretimde doğrulandı
   - [x] Firefly: Kling 2.5 (start_only çift ordinal) — HAZIR, gerçek test OK
   - [x] Firefly: Runway 4.5 (start_only tek ordinal) — HAZIR, gerçek test OK
   - [x] Firefly: `end_only` (Ray3.14 frame_last→promptReference 2) — HAZIR, scene_031'de doğrulandı
   - [x] **FIREFLY TARAFI TAMAM** (tüm frame_mode'lar HAZIR adaptöre gidiyor)
   - [x] Hailuo 2.0 (both/end_only, model 23210) — HAZIR, German scene_003'te uçtan uca doğrulandı.
         Poll: my-work-detail HTML → `downloadURLWithoutWatermark` (WATERMARKSIZ) → indir.
   - [x] Hailuo 2.3 (start_only, model 23217) — HAZIR, German scene_010'da doğrulandı (start-frame kabul).
         RQ2 CEVAPLANDI: 23217 **both-mode'u reddediyor** (2× API error 2400001, farklı requestID) →
         2.3 yalnız start_only, mevcut yönlendirme doğru (both→2.0). Model tablosu değişmez.
   - [x] **HAILUO TARAFI TAMAM** — her iki pipeline (Firefly + Hailuo) tüm frame_mode'larda CANLI.
   - [x] Provider-aware pacing: runner PACING'i (firefly 4-8s / hailuo varyant 120-180s + sahne 160-400s).
         Hailuo ayrıca adaptörde wait_for_queue (kuyruk<4) + heartbeat. Kota harcamadan doğrulandı.
   - [x] Retry katmanı (core.retry): upload/generate/poll/download geçici hatada (SSL/Conn/Timeout/5xx)
         exponential backoff (5/15/45s, 3 deneme); 401/403/4xx + SystemExit hemen durur. Firefly + Hailuo.
         Ray3.14 firefly-3p ailesine taşındı (payload birebir korundu) → poll/download retry'li, generate
         tekrarlanmaz. Stub ile doğrulandı. (scene_006 SSL blip'i bu açığı ortaya çıkarmıştı — düzeltildi.)
   - [ ] **video_router katmanı SAĞLAM — tam batch üretime hazır.** (sonraki: prompt üretimi katmanı)
2. **SONRA prompt üretimi bağlansın** — `gemini_direct.py`'yi bağımsız katman olarak
   video_router'ın önüne koy (scenes.json + keyframes → v1/v2/v3 + frame_mode).
3. **EN SON studio + orchestrator** — Scene Studio beslemesi standartlaşsın, üstüne
   tüm zinciri süren orchestrator komutu.

## Katman 2 — karakter tutarlılığı (swapped keyframe) — ÖNEMLİ tasarım sorunu

**Sorun:** Gemini ORİJİNAL videoyu izliyor ama üretim SWAPPED keyframe'den yapılıyor →
prompt ile başlangıç görseli çelişebilir. Örn: orijinalde **kel bebek**, swapped'de
**turuncu kıvırcık saçlı çocuk**; Gemini prompt'a "kel bebek" yazıyor, Hailuo/Firefly
swapped kareden başlıyor → prompt↔görsel çelişkisi → **morphing / karakter kayması riski**.

**Çözüm seçenekleri (katman 2'de değerlendirilecek):**
- (a) Gemini'ye SWAPPED keyframe'leri de göster — video = hareket/olay, keyframe = karakter görünümü.
- (b) Bağlam dosyalarına (`_characters.txt`) SWAPPED karakter tarifini yaz.
- (c) Prompt'ta karakter görünümünü HİÇ tarif etme — yalnız aksiyon + kamera; görünümü keyframe belirlesin.

**Şimdilik:** deneme koşularında mevcut haliyle devam; sonuçlara (morph var mı) bakıp seçim yapılacak.

**İki tasarım sorusu (L1'de cevaplanacak):**

1. **Gemini'ye video mu, swapped keyframe mi göstermeli?** → İkisi de gerekli, biri diğerinin yerini
   TUTMAZ. Video **hareketi** taşır (irkilme, atılma, kamera); iki durağan kare bunu söylemez. Swapped
   keyframe **görünümü** taşır (modelin gerçekte göreceği). Morph riski tam bu ayrımdan: Gemini orijinali
   izliyor (kel bebek), üretim swapped keyframe kullanıyor (turuncu kıvırcık saç) → prompt↔görsel çelişkisi.
   Çözüm "video yerine frame" değil, **aynı istekte ikisi birden**.
   - **AMA:** Studio'nun yeni alanları (sahne ana konusu = kim ne yapıyor, duygu, kafa pozisyonu) hareketi
     zaten tarif ediyor olabilir → yeterliyse Gemini videoyu izlemeye gerek kalmaz → **Gemini kota sorunu
     da çözülür** (250/gün, sahne başına 2 istek).

2. **"Kim kimle değişti" bilgisi verilmeli mi?** Üç seçenek: (a) swapped keyframe'i göster, (b) swap
   eşlemesini metin ver, (c) prompttan görünüm tarifini tamamen çıkar.
   - **Ön değerlendirme: (c) muhtemelen en sağlamı.** Keyframe zaten görünümü gösteriyor, model onu görüyor.
     Prompt'ta "turuncu kıvırcık saçlı bebek" demek en iyi ihtimalle gereksiz, en kötüsü çelişki kaynağı.
     Prompt yalnız **eylemi** söylesin ("bebek irkilir, kız öne atılır"), kimlik keyframe'de.
   - **Kanıt:** Bug_Chaos scene_011 promptu görünüm tarifi içermiyor ("the baby/boy/girl") → çalıştı.
     Waterpark scene_011 "baby with curly orange hair" yazmıştı — Gemini orijinalde görmediğini tesadüfen
     doğru yazmış, şans eseri.
   - **(b) ne zaman gerekir:** karakter keyframe'de belirsizse (sırtı dönük, uzakta, kısmi) → kimliği prompt taşımalı.

**ÖNKOŞUL: RQ1 review.** Morph gerçekten oluyor mu? 176 video izlenmedi. Waterpark (swapped) vs
Bug_Chaos (orijinal) = kontrollü karşılaştırma. Morph yoksa (c) zaten yeterli, iş yok; varsa seçim yapılır.

## Katman 2 (L1) — prompt üretim YOLU: master.py vs gemini_direct.py (ARAŞTIRMA SORUSU)

İki farklı prompt üretim yolu var, **ikisi de aynı çıktı dosyasını** üretiyor
(`hailuo_prompts_claude.json` — **isim yanıltıcı**, gemini_direct'te Claude YOK):

- **(1) `master.py`** — Gemini video analizi → **Claude API** v1/v2/v3 yazıyor (iki-motor).
  Dil/kültür dosyaları (`tr.py` / `en.py` / `de.py`) **Claude tarafında** kullanılıyordu → bu zenginlik burada var.
- **(2) `gemini_direct.py`** — Gemini hem izliyor hem promptu yazıyor (tek-motor).
  Dil/kültür zenginliği YOK. **Bugünkü Waterpark/Bug_Chaos koşuları bununla yapıldı.**

**Soru:** L1'de hangisi STANDART olacak? Karşılaştırma gerek — **Gemini-tek** mi, yoksa
**Gemini-analiz + Claude-prompt** mu daha iyi Hailuo/Firefly promptu üretiyor?
(Kalite karşılaştırması RQ3 ile aynı review aşamasında yapılabilir.)

**Ek işler:**
- **Dosya adı netleştirilmeli** — hangi motorun ürettiği belli olsun (ör. `prompts_<engine>.json`
  veya JSON içine `engine` alanı). Mevcut `hailuo_prompts_claude.json` iki yol için de kafa karıştırıyor.
- Dil/kültür dosyalarının (tr/en/de) gemini_direct yoluna da taşınıp taşınmayacağı kararı.

**Önkoşul:** RQ1 (karakter tutarlılığı) + RQ3 (kalite) review'i — sonuçlar bu kararı besler.

## L1 — Gemini KOTA kısıtı (SERT kısıt, üretim hattı için kritik)

`gemini-3.1-pro` günlük limit **250 istek/gün**. Mevcut iki-turlu yapı (üretim + self-check)
sahne başına **~2 istek** harcıyor → **122 sahnelik tek video ≈ 244 istek = günün tamamı.**

**Bugün yaşandı:** Bug_Chaos 122 koşusunda 429 RESOURCE_EXHAUSTED; **16 sahne promptsuz kaldı**
(104-108, 110, 112-116, 118-122; içlerinde videonun TEK end_only'si scene_118). Kota ~13.7s
sonra sıfırlanır → eksik 16 yarın üretilip resume ile tamamlanacak. **Üretim hattı için bu çalışmaz.**

**429 ham gövde analizi (Bug_Chaos full log):**
- `quotaId = GenerateRequestsPerDayPerProjectPerModel`, `quotaValue = 250`,
  `quotaDimensions = {location: global, model: gemini-3.1-pro}`, retryDelay ~13.8h (günlük).
- Limit **proje-başına + model-başına + günlük** → ayrı projeler bağımsız 250'şer alır.
- Mesajda **"free tier" GEÇMİYOR** (yalnız "plan/billing details"). 250/gün *tipik free-tier şekli*
  ama gemini-3.1-pro **preview** → ücretli tier'da bile düşük proje-tavanı kalabilir.
- **Proje numarası gövdede YOK**; API key'den (AIza…) proje türetilemiyor → GEMINI_API_KEY'in
  hangi GCP projesine ait olduğu **AI Studio/konsoldan** bakılmalı (henüz bilinmiyor).

**Web araştırması + AI Studio DOĞRULAMASI (2026-07):**
- **Billing 250 RPD'yi KALDIRMIYOR — DOĞRULANDI (AI Studio).** Hesap zaten **billing açık + Tier 1**,
  yine de 250 RPD'ye takıldı. Billing **RPM'i ~30x** artırıyor ama **RPD'ye dokunmuyor.** → billing ELENDİ.
- **Tier 2** = **$250 birikmiş GCP harcaması + ilk ödemeden 30 gün** → RPD kalkıyor. Postpay olduğu için
  **pasif birikiyor** → en erken ~bir ay sonra kendiliğinden gelir.
- **Batch API** normal API'den **AYRI rate limitlere** tabi ve **yarı fiyat** (resmi doküman).

**Key rotasyonu — BUGÜN uygulanabilir (PerProject havuzlar):**
- Default Gemini Project = `gen-lang-client-0721386964` — **MEVCUT key burada** (`AQ.Ab8RN…xf6w`,
  ~/.zshrc'den export). **Bugün tükenen havuz bu.**
- Video Projct = `gen-lang-client-0610344982` (key `…lGmA`) — **taze 250, bugün kullanılabilir.**
- (My First Project = `supple-kayak-301910` → **Free tier**, 3.1 Pro'da güvenilmez → SAYMA.)
- → Bugün **2 × 250 = 500 RPD**. Yeni proje açılırsa +250.
- **KRİTİK NÜANS:** aynı projedeki **birden fazla key AYNI havuzu paylaşır** (Default'ta 6 key var,
  hepsi tek 250'den yiyor). Rotasyon **PROJE bazında** olmalı, key bazında değil — **her projeden BİR key.**

**Çözüm seçenekleri — YENİ öncelik sırası (web araştırması sonrası):**
1. **Batch API** — EN TEMİZ gibi (**ayrı kota havuzu + yarı fiyat**). Prompt üretimi interaktif değil
   (122 sahne gece kuyrukta bekleyebilir) → iş yükü batch'e birebir uygun.
   **ARAŞTIRILACAK (uygulanabilirliği belirler):** Batch API **video girdisini** destekliyor mu?
   gemini_direct videoyu **Files API**'ye yüklüyor → batch ile uyumlu mu?
2. **Key rotasyonu** — quotaId "PerProject" → **KESİN çalışır**. **BUGÜN 2 proje = 500 RPD** hazır
   (yukarıdaki proje envanteri). Rotasyon **proje bazında** (her projeden bir key). VPS'te 3-proje deseni var.
3. **İkinci turu Claude'a devret** — kota yarıya iner + dil/kültür dosyaları (tr/en/de) geri gelir
   (bkz. "prompt üretim YOLU" — master.py yönüyle örtüşür).
4. **Flash/Pro bölüşümü** — Flash/Flash-Lite RPD'si çok daha yüksek (**1000+**). İş bölünür:
   **sahne analizi → Flash**, **prompt yazımı → Pro**.
5. **Billing** — **ELENDİ** (zaten Tier 1, RPD yine 250). RPM'i açar + Tier 2 yolunu pasif başlatır ama
   RPD'yi çözmez → tek başına işe yaramaz.

> Not: (c) eski "tek istekte çoklu sahne" notu YANLIŞ vurguydu — Batch'in asıl kazancı
> **ayrı kota havuzu + yarı maliyet**, istek-birleştirme değil.

## L1 — Model-ÖZEL prompt formatı (ARAŞTIRMA + yeniden amaçlama)

Şu an **tek prompt seti** üretiliyor, hepsi **Hailuo kurallarına** göre (kamera direktifi +
aksiyon + stil; **V2 = yüz mikro-mekaniği**). Ama aynı prompt Ray3.14 / Kling 2.5 / Runway 4.5 /
Veo 3.1'e de gidiyor → **optimal değil** (her modelin prompt beklentisi farklı olabilir:
uzunluk, kamera dili, negatif prompt, stil etiketi).

- **Araştırma:** her modelin resmi/pratik prompt rehberi ne diyor?
- **Kullanıcı fikri (yeni katman EKLEMEDEN):** gemini_direct'te zaten bir **ikinci tur (self-check)**
  var → o turu "kural kontrolü" yerine **model-özel çeviriye** dönüştür. Mevcut geçişi yeniden amaçlar.
- **Açık soru:** V2 = "yüz mikro-mekaniği" Hailuo'ya özgü — **Firefly modellerinde V2 ne olacak**
  (başka bir şey mi, hiç mi olmasın)?

## L2 — Süre (video_duration) MODEL-BAĞIMLI eşleme (ÖLÇÜLDÜ, KOD İŞİ — karar bekliyor)

Yeni Studio formatı (**version: 2**) `video_duration` alanını **dolduruyor** (ölçüm: 6×27, 10×2 /
"Someone in the bed"). Eski format (Waterpark/Bug_Chaos) bu alanı taşımıyor (`duration` hep 0 = ölü).
Router şu an süreyi **model-başına sabit** gönderiyor, `video_duration`'ı hiç okumuyor:

| Model | kaynak | gönderilen | ffprobe (gerçek) |
|---|---|---|---|
| Hailuo 2.0/2.3 | `_hailuo.py:28` sabit `DURATION=6` (job.duration yok sayılır) | 6 | **~5.9s** |
| Ray 3.14 | `ray314.py:47` `job.duration` ← `--duration` (default 5) | 5 | **5.04s** |
| Runway 4.5 | `runway45.py` sabit `DURATION=8` | 8 | **8.04s** |
| Kling 2.5 | `kling25.py` sabit `DURATION=5` | 5 | — |

- **`--duration` bayrağı YALNIZ Ray 3.14'ü etkiler**; Hailuo/Runway/Kling sabit kullanır.
- **Hailuo 176 video = ~6s** → çoğunluğun istediği (video_duration=6) ile örtüşüyor, sorun yok.
- **BUG:** `video_duration=10` (scene_011/022) **sessizce 6s üretilir** (hata vermez, kurgu bozulur).
- **Süre model-bağımlı:** Hailuo {6,10?} · Ray {5,?} · Runway {8} · Kling {5} · Veo {4/6/8}.
  Tek `video_duration` her modele aynı gidemez → **model-başına kabul-listesi + en-yakın eşleme** gerekir.
- **✅ KÖK NEDEN (17 Tem, curl+ffprobe): 10sn MUMKUN ama yalniz 720p ile.** `2400001` süreden değil,
  **`duration=10` + `resolution="1080"`** kombinasyonundan geliyordu (panel 10s'yi `resolution="768"` ile
  gönderiyor). **Firefly 403'ün birebir aynı deseni** (Ray 1080p→403, 720p→sınırsız) — çözünürlük↔yetenek bağlı.
- **(süre,çözünürlük) ÇİFT tasarımı:** Hailuo `{6:"1080", 10:"768"}`. `hl_generate_video` artık `resolution`
  parametreli (sabit "1080" idi). Adaptör (_hailuo) `duration`'a göre resolution seçer: **10→768 + `[UYARI-COZ]`**
  (sessiz DEĞİL; --resolution 1080p çakışırsa "süre ezdi" der). Accept-list Hailuo {6,10}.
- **✅ CANLI+ffprobe doğrulandı (scene_022, both/2.0, vd=10):** code 0 (2400001 yok), **10.167s + 1364×768
  (720p-tier)**. TAKAS: 6sn@1080p ↔ 10sn@720p, ikisi birden olmuyor; video_duration=10 → 10@720p seçilir+uyarılır.
- **Fix uygulandı:** gemini_direct `video_duration`/`video_model` → prompts JSON; runner `_resolve_duration`
  (stub 13/13); adaptörler `job.duration`; _hailuo (dur,res) çifti (gerçek-submit stub geçti). Regresyon: vd yok
  → model default (6@1080), birebir eski davranış.
- **✅ 2.3/start_only 10sn de KABUL (scene_011, model 23217, 10@768, code 0):** hem 2.0(both) hem 2.3(start_only)
  10sn@720p üretiyor. **Açık:** Ray `duration=6` üretiyor mu (native 5)?
- **Not:** `version:2` alanı temiz format-tespiti (eski dosyalarda yok) → okuyucu sürüme göre davranmalı.

## end_only KIRIK — ONAYLANMIŞ BUG (frame-MSE ile kanıtlandı, 17 Tem)

**Kanıt:** üretilmiş `scene_003_hailuo20_v1.mp4` — `frame_last.jpg` videonun **İLK** karesiyle MSE **4.3**
(neredeyse birebir), **SON** karesiyle MSE **10824.9**. → verilen kare videonun BAŞINDA.

**Kök neden:** Hailuo bu implementasyonda yalnız iki `reference_mode` sunuyor:
`"start-frame"` (frameType:0) ve `"start-end-frames"` (frameType:0=first + 1=last). **Tek-başına
end-frame modu YOK.** end_only kodu frame_last'ı `frameType:0` + `"start-frame"` ile gönderiyor →
Hailuo **başlangıç** sanıyor. Kod yorumu itiraf ediyor ("last frame'i start olarak gonder... oradan ileri
üretir") ama niyeti (video o kareye VARSIN) karşılamıyor.

- **Etki:** "Someone in the bed" koşusunda **6 sahne × 3 = 18 video** semantik YANLIŞ
  (003/008/012/013/014/015). end_only "ilk gerçek testi" = test edildi, **KIRIK bulundu**.
- **Firefly'da da end_only çalışmıyor** (kullanıcı) → **end_only'nin gidecek yeri olmayabilir.**
- **✅ ÇÖZÜM BULUNDU (ayrı script + MSE ile doğrulandı, 17 Tem):** `"start-end-frames"` modu **yalnız
  `frameType:1`** ile (start YOK, sadece last) → **Hailuo KABUL ETTİ** (code=0). Üretilen videoda
  `frame_last` ↔ video SON kare MSE **5.6** (İLK kare 606.8) → **kare gerçekten SONDA, gerçek end-frame.**
- **DÜZELTME (tek satır, henüz UYGULANMADI — koşu canlı):** `hl_generate_video` end_only dalı:
  `frameType:0 + "start-frame"` → **`frameType:1 + "start-end-frames"`**.
- **Uygulanınca:** mevcut koşudaki 6 end_only sahne × 3 = 18 video yeniden üretilmeli (mp4 sil → resume üretir).
- **Regresyon riski:** both modu zaten `"start-end-frames"` kullanıyor (frameType 0+1) → çakışmaz; düzeltme
  sonrası both + start_only + end_only üçü de ÇIKTI-ÖLÇÜLEREK (MSE) doğrulanmalı.

**✅ DÜZELTME UYGULANDI + ÜÇ MOD MSE İLE DOĞRULANDI (17 Tem):**
- **Kod:** `hl_generate_video` end_only → `frameType:1 + "start-end-frames"`. Stub testi (gerçek fonksiyon,
  API monkeypatch): both DEĞİŞMEDİ (0+1/start-end-frames), start_only DEĞİŞMEDİ (0/start-frame),
  end_only DÜZELDİ (1/start-end-frames).
- **both — İLK KEZ ölçüldü, TERS DEĞİL:** scene_001/005/006 → first↔vidİLK {1.9,1.1,2.1}, last↔vidSON
  {57.8,20.0,2.0} (düşük=doğru); çapraz {469-1460} (yüksek). → frameType 0=başta, 1=sonda. **98 Bug_Chaos
  + 5 bu proje both sahnesi SAĞLAM.**
- **start_only — doğru:** scene_002/004 first↔vidİLK {6.1,3.8} düşük.
- **end_only — ✅ CANLI DOĞRULANDI (17 Tem):** gerçek adaptörle (`--scenes 3,8,12`) yeniden üretildi;
  **kullanıcı videoları izledi — video verilen kareye VARIYOR.** Düzeltme tam onaylandı (stub + ayrı script +
  gerçek adaptör + insan gözü). end_only artık üç yolla (payload/MSE/insan) doğru.

## L1 — YÖN notu (muhtemel yeniden inşa)

Kullanıcı, mevcut prompt üretim yapısının bu haliyle **yetersiz** olduğunu, L1'de büyük ölçüde
**yeniden inşa** gerekebileceğini söyledi. Karar **RQ3 review'inden sonra** — ama yön:
**master.py (Gemini analiz + Claude prompt + dil/kültür dosyaları)** ile **gemini_direct (tek motor, basit)**
ikisinin **birleşimi** olması muhtemel.

## L1 / HIZ — Hailuo prompt OPTIMIZER (useOriginPrompt) — koşuyu bölme, sıra gelince test

Hailuo ilk işte **prompt "optimizing"** yapıyor, süre alıyor (kullanıcı gözlemi). Payload'da alan zaten var:
**`useOriginPrompt: false`** (curl'de yakalandı) — **false = optimize et**, **true = olduğu gibi gönder**.
İKİ AYRI SORU:
- **✅ TOGGLE BAĞLANDI (18 Tem):** `core.Job.prompt_optimizer` (default True=optimize=mevcut) → `_hailuo`
  `use_origin_prompt=(not job.prompt_optimizer)` → `hl_generate_video(use_origin_prompt=...)`. CLI `--no-optimizer`.
  Gerçek-submit stub: regresyon (alan set edilmezse useOriginPrompt=False, mevcut korundu) + True→optimize +
  False→verbatim. **L2.5 config'te model-bağımlı `options` (Hailuo toggle, Firefly yok).**
- **✅ (a) SÜRE TESTİ KOŞULDU (18 Tem, scene_007, ON vs OFF) — ERKEN SONUÇ:** optimizer ON submit→"Generating"
  = **177s AMA çoğu LOW-SPEED KUYRUK beklemesi** (feedMessage'ta "Optimizing" yalnız kısa göründü, sonra
  "Low-speed...please wait"). OFF turu low-speed'de takıldı, kullanıcı iptal etti → **net ON−OFF farkı ölçülemedi**
  ama erken sinyal yeterli: **optimizing süresi kuyruk beklemesinin yanında küçük → optimizer'ı kapatmak muhtemelen
  SÜRE KAZANDIRMAZ.** Değeri = **KONTROL** (verbatim prompt, deney için temiz değişken), süre değil.
  Kesin fark için low-speed OLMAYAN anda tekrar (opsiyonel, düşük öncelik). opt_on.mp4 kaydedildi (kalite gözle).
- **Toggle L1 için HAZIR:** `--no-optimizer` çalışıyor (gerçek-submit stub geçti); L1 deney altyapısında verbatim vs
  optimize karşılaştırması yapılabilir.
- **(b) KALİTE:** optimize prompt'u yeniden yazıyor. Kapatınca tam kullanıcının yazdığı gider → kontrol artar
  ama Hailuo'nun **model-uyumlu ayarı** kaybolabilir. Çıktı izlenerek karar.
- **DERİN FIRSAT:** optimizer'ın ne yaptığını çözersek → **Gemini prompt yazarken onu taklit eder** → hem gecikme
  gider hem kontrol bizde. Gerekli: optimizer girdi/çıktısını görmek. `promptStruct`'ta optimize edilmiş hali
  dönüyor mu, sunucuda mı kalıyor? **Kullanıcı F12'de "optimizing" sırasında istek/cevap yakalar** → optimize
  edilmiş prompt görünürse, birkaç örnekten desen çıkarılıp Gemini prompt'una eklenir.
- Sıra: koşu bitince (a) [ucuz, hız]; (b) + derin fırsat izleme + F12 sonrası.

## L1 — VİZYON: prompt DENEY altyapısı (kullanıcı, 17 Tem)

**HEDEF:** modüler, değiştirilebilir, **teker teker test edilebilir** prompt üretimi. İdeal prompt yapısı +
JSON'dan gelen ekstra bilgiler tek videoda varılacak karar DEĞİL — **zaman içinde ÖLÇÜLEREK** gelişecek.
Uzun vade: aynı sahneyi her modele **farklı prompt yapılarıyla** gönderip hangi model + hangi yapı daha iyi,
ölç. → **L1 bir "prompt yazıcı" değil, prompt DENEY altyapısı.**

**LOOP ↔ MODEL gözlemi (M1'i etkiler, ÖLÇÜLMELİ):** Loop yoğunluğu model değişince rahatlıyor. Hipotez:
(1) **both (2.0)** son kareyi hedef koyduğu için loop'u **bastırıyor**; **start_only (2.3)** çapasız kaldığı için
loop'a giriyor. (2) **2.0 ve 2.3 AYRI kuyruk yuvalarına sahip olabilir** → B testi tek model ölçtü (ls_peak=2);
iki model paralel koşarsa gerçek eşzamanlılık **2'den fazla** olabilir → **M1 tasarımını etkiler, ölçülmeli.**

**MORPH:** kullanıcı izledi — genel olarak YOK. **RQ1 KAPANDI** (L1'de öncelik değil).

**L1 AÇIK SORULARI (izleme + deney sonrası karara bağlı):**
- **v1/v2/v3 yapısı değişecek.** v2="yüz mikro-mekaniği" Hailuo'ya özgü seçimdi; swap marker az olan projede
  (örn. Traffic Rules 4 marker) v2 ne işe yarar?
- **VARYANT SAYISI = `alternative_scene` (SAYI: kaç varyant, 1-3) — gemini_direct OKUYACAK (L1 işi, runner DEĞİL).**
  Şu an gemini_direct her sahneye KÖR olarak v1/v2/v3 yazıyor. Doğru: `alternative_scene`'e göre sahne-başına
  o kadar FARKLI prompt yaz (1 → yalnız v1; 2 → v1,v2). Runner zaten "dolu-olan-üret" (boş v'yi atlar,
  satır 359/531) → ekstra mantık GEREKMEZ; katman gemini_direct. **Runner'a auto-mode denendi → GERİ ALINDI**
  (yanlış katman). Panel karışmaz (`--variants v1,v2,v3` superset gönderir, runner dolu olanı üretir).
  `alternative_scene` **prompts JSON'a taşınıyor** (gemini_direct propagate — L1 kullanacak, hazır). Örnek
  (Shapes on Wheels): çoğu sahne 1, scene_002/006/009=2. **Not:** SAYI = "ilk N"; "v1,v3 (v2 atla)" gibi serbest
  kombinasyon isteniyorsa Studio alanı LİSTE olmalı (ayrı Studio işi) — şu an sayı, yani "ilk N".
- **Efekt sistemi = `geekfree` + `scene_main_topic`.** Fiil→efekt sözlüğü (üflemek→üfleme çizgileri,
  şaşırmak→ünlem, kafası karışmak→soru işareti, uyumak→zzz). **ElevenLabs tag kütüphanesi deseni** — LLM'e boş
  sayfa değil, **seçilebilir sözlük** ver. ⚠️ Boşluk: scene_main_topic 2/10 dolu ama geekfree 7/10 True →
  5 sahnede efekt isteniyor, fiil yazılı değil → ya alan doldurulacak ya LLM `scene_description`'dan çıkaracak
  (Gemini zzz'yi oradan yakalamıştı — becerebilir).
- **`camera_angle`(6/10) + `camera_angles`(çoğul) HİÇ OKUNMUYOR** → `scene_description` gibi prompt'a verilmeli.
  (Fix #3 `camera_angles`'ı zaten BİLİNMEYEN alan olarak yakaladı.)
- **6 SANİYE TUZAĞI:** min 6sn; 2sn'lik eylemler loop'a giriyor (kapı kolu aşağı-yukarı). Yönler: (a) eylem+oturma
  ("kapıyı açar, girer, durup etrafına bakar"), (b) **both modu** — son kare hedef koyar (loop gözlemi bunu destekliyor),
  (c) `[slow motion]`, (d) kurguda kırp. (Not: 10sn artık mümkün ama 720p — süre uzatmak da bir yön.)
- **Motor:** gemini_direct (tek) mi, master.py (Claude + dil/kültür) mı, birleşim mi?
- **Global bağlam** (tema/karakter/ton): interaktif soru otomasyonda ÖLÜ → JSON'a `project_context` bloğu mu?
  (bkz. L1/RQ3 global bağlam bölümü)
- **Kota fırsatı:** scene_description zenginleştikçe Gemini'nin **videoyu izlemesi gereksizleşebilir** →
  250/gün sorunu hafifler + hız artar (video upload + analiz kalkar).

## L1 / RQ3 — GLOBAL BAĞLAM değişkeni (KEŞFEDİLDİ — kalite karşılaştırmasını etkiler)

gemini_direct başlangıçta **3 parçalı global bağlam** soruyor (1. tema/özet · 2. karakterler+görünüm ·
3. tema/ton) + face-swap sorusu. **Non-interactive koşuda (`< /dev/null`) hepsi boş geçiliyor**
→ "bağlamsız devam ediliyor". **Bugüne kadarki TÜM koşular böyle çalıştı** — global bağlam hiç verilmedi:

| Proje | global bağlam | scene_description | Gemini ne gördü |
|---|---|---|---|
| **Bug_Chaos** | YOK | **122/122 BOŞ** | yalnız video + keyframe (EN KÖR koşu) |
| **Waterpark** | YOK | TR metin var | video + keyframe + sahne notu |
| **Someone in the bed** | YOK | 29/29 dolu (zengin) | video + keyframe + zengin sahne notu |

- **RQ3 etkisi:** prompt kalitesi zayıfsa sebep **model değil, girdi eksikliği** olabilir. Kalite
  karşılaştırması bu değişkeni **sabitlemeli** (aynı bağlam koşulu), yoksa model≠girdi karışır.
- **L1 TASARIM SORUSU — global bağlam nereden gelmeli?** (otomasyonda interaktif soru **sürdürülemez**:
  VPS/panel/L2.5'te kimse cevap veremez)
  - (a) her koşuda elle sor — otomasyona AYKIRI
  - (b) proje klasöründe `context.txt`/JSON alanı
  - (c) Studio'ya proje-seviyesi alan (scene_main_topic gibi ama proje geneli)
  - (d) `char`/marker alanlarından otomatik türet
- **Not:** face-swap=hayır default'u kontrol grubu projelerinde (orijinal keyframe) **doğru**.

## M1 ÖNKOŞULU — vid_id kaydı + aşama-farkında ASİMETRİK retry (KOD İŞİ, M1'den ÖNCE)

**Kök sorun:** poll aşamasında SSL kırılganlığı (`TLSV1_ALERT_INTERNAL_ERROR`, hailuoai.video) +
**vid_id kaydedilmiyor**. Üretim başarılı olsa bile **poll ölünce video kayboluyor** — biz bilmiyoruz,
panelde duruyor. (Waterpark 13-72: 15 SSL hatası dar pencerede + gece internet kesintisi; 051 aynı
blip'leri retry ile atlattı, 050/052 tüketti. Sahneye özgü DEĞİL — zaman-pencere.)

**Teşhis kanıtı (aşamalar farklı, hata mesajı aynı görünüyor — sorun bu):**
- scene_050: submit OK (vid_id `533915260521484290`) → **POLL** öldü → elle kurtarıldı (my-work-detail, 1s'de HAZIR).
- scene_052: **GENERATE POST** öldü (vid_id YOK) → re-run'da ayrı sorun çıktı (2400002 içerik ihlali).
- scene_051: aynı SSL blip'leri (5×) → retry **kurtardı**, indi. → ısrar çalışıyor, derinlik yetmedi.

**Gerekli düzeltmeler (M1'den ÖNCE):**
1. **vid_id progress'e yazılsın — submit başarılı olur olmaz.** Resume: vid_id varsa **yeniden ÜRETME**,
   sadece **poll+download** tekrarla. (050'yi bugün elle kurtardık; otomatik olmalı.) **Firefly'da da gerekli** —
   gerekçe kredi DEĞİL (720p fix'ten sonra kredi yanmıyor), **poll'da SSL patlarsa video yine kaybolur**.
   (dry-run kazasında scene_013 generate'de öldü; vid_id kaydı olsaydı kurtarılırdı.)
2. **Aşama-farkında ASİMETRİK retry** (şu an üçü de 3 deneme — yanlış):
   - **submit** (generate/upload): **3 deneme** (muhafazakâr — SSL POST cevabını öldürüp sunucu iş
     yaratmışsa **mükerrer** riski). Retry'dan önce "bu sahne için zaten iş var mı" (my-work listesi) kontrolü düşünülmeli.
   - **poll**: **ZAMAN-BAZLI, ~10 dk ısrar** (örn. 5/15/45/60×N ≈ 8-9 dk). Video sunucuda, kaybetmek saçma.
     Deneme-bazlı (3×20s≈20s) bir **internet kesintisini** (dakikalar) atlatamaz; koşular 4-5h gece boyu → kesinti normal.
   - **download**: **5+ deneme**.
3. **Hata mesajı AŞAMAYI söylesin** (submit/poll/download) — şu an üçü de "Max retries", ayırt edilemiyor
   (050 poll ≠ 052 generate, aynı görünüyordu).

**M1 için KRİTİK:** paralelde 3-5 iş **aynı anda** poll edilir → aynı TLS fırtınası/kesintide **hepsi birden**
retry tüketir → **toplu kayıp**. vid_id kaydı + derin poll retry + mükerrer kontrolü **M1'den önce** kurulmalı.

**✅ CANLI DOĞRULANDI — uyku/kesinti senaryosu (Someone in the bed, 17 Tem):** Mac şarj bitince
**uykuya geçti** (~saatlerce), süreç dondu ama ölmedi; fişte kaldığı yerden devam etti (etime 10h uykuyu
kapsıyor). Uykuda ağ koptu → poll SSL alacaktı, ama **30dk poll ısrarı taşıdı**. Sonuç: 87 videoluk
gece koşusu **0 error, 0 kayıp**. Eski 3×20s poll olsaydı uykuda kalan sahneler ölürdü. Ayrıca ayrı bir
manuel restart'ta (v1→v1,v2,v3 geçişi) **scene_002 v1 vid_id ile resume edildi** (submitted→poll+download,
yeniden üretim yok). Mekanizma gerçek dünyada çalışıyor — stub değil.

## M1 ÖNKOŞULU — TEMEL VARSAYIM ÖLÇÜMLERİ (sonuç gelmeden M1 kodu YOK)

Kullanıcının iki itirazı M1'i kökten sorguluyor: (1) Hailuo hesabı **sabit kapasiteli** olabilir (12 iş
→ hepsi yavaşlar) → paralellik kazanç vermez, M1 ölü. (2) Hız **sunucu yoğunluğuna** bağlı, değişken →
`wait_for_queue` zaten dinamik ayarlıyor; o zaman **sabit pacing** ne işe yarıyor?

**A) Pacing gerçekten gerekli mi — en yüksek getiri/en düşük risk (M1'DEN BAĞIMSIZ):**
- **✅ ÖLÇÜLDÜ (Someone in the bed, 25 sahne / 74 video gerçek log):** `wait_for_queue` **75 submit'in
  73'ünde kuyruğu BOŞ buldu** (N=0); hiç bloke olmadı (`Kuyruk dolu`=0); max N=2. → **kuyruk sıralı akışta
  hiç dolmuyor, pacing boş kuyruk üstüne kör gecikme.** Zaman: üretim 398dk, **pacing 138dk (%26)**.
- **pacing=0 canlı testi (3 end_only sahne):** ceza YEMEDİK — üretim 236/254s (normal, uzamadı), popUp:false,
  rate-limit/slow YOK. Ama zayıf stres (2 taze sahne). Paneldeki "2 eşzamanlı iş" tek runner'dan DEĞİL,
  önceki koşunun sunucuda işlenen işiyle **çakışmadan** — tek sıralı process pacing=0'da bile ~1 iş çalıştırır.
- **→ ÖNERİ: Hailuo pacing'i KALDIR, yalnız `wait_for_queue`'ya güven (heartbeat öne).** ~%26 hız.
  (Firefly'da GEÇERSİZ — Adobe tek-video, sıralı kalır.)

**PACING TASARIMI = TEPKİSEL, SABİT DEĞİL (yeni çerçeve — kullanıcı):** Hailuo panelde bazen
**"wait 4 minutes — slow generation mode"** çıkarıyor; peş peşe talepte oluşuyor, göndermeyi kesince ceza
kalkıyor. → fren **tepkisel** (ani yığılmaya karşı), kullanıma karşı değil. Üç mod:
- Sabit pacing (90-140s): kör → %26 israf (ölçüldü).
- Sıfır pacing: yığılırsa ceza → 4 dk.
- **Tepkisel (doğru): hızlı git → fren sinyalini görünce geri çekil (60→120→240s) → ceza kalkınca kademeli hızlan** (klasik tıkanıklık kontrolü).
- ⚠️ "slow generation mode" muhtemelen hesabın iş modeli (sınırsız üretim, yoğunlukta kısıtlı hız);
  frenle fazla oynamak hesabı riske atabilir. Amaç: **gereksiz beklemeyi kaldırmak, cezayı atlatmak değil.**

**"LOW-SPEED GENERATION" = HESABIN İŞ MODELİ (ceza DEĞİL) — panel + HTML ile kanıtlandı:**
Panelde işlerken çıkıyor: *"Low-speed generation, please wait Nmins — Recharge to speed up"* + [Recreate]/[Cancel].
HTML'de iş-modeli metni: *"Continued access to Hailuo 01 & 02 in **slow mode, even after credits run out.
No limits. No downtime.**"* → **sınırsız↔yavaş takası** (Luma Relaxed / Firefly promo mantığı). **Bizim
tetiklediğimiz yaptırım DEĞİL.** Amaç: gereksiz beklemeyi kaldırmak, cezayı atlatmak değil.

**✅ SİNYAL MAKİNEYLE OKUNABİLİR — KESİN (sinyal SUBMIT'te değil POLL/processing'te):**
- Sinyal **`/api/feed/creation/my/processing` cevabında, her feed'in `feedMessage.message` alanında**:
  `"Low-speed generation, please wait <whiteText>3mins</whiteText>..."`. Normal işte "Optimizing prompt...".
- **Bu endpoint'i ZATEN her submit'te (heartbeat) çağırıyoruz** — kod yalnız `onProcessingVideoNum`'ı
  okuyup gerisini atıyor. Ek istek GEREKMEZ: `feedMessage.message`'ı oku → **iş-başına** low-speed durumu +
  **tahmini bekleme (Nmins) parse edilebilir**.
- generate cevabında YOKTU (`popUp:false`) — spinner üretimde döndüğü için sinyal orada değil, doğru yer poll.
- Gözlem: 2 eşzamanlı işin İKİSİ de low-speed (3min+4min) → **kapasite paylaşılıyor**. Ve normal üretimimiz
  ~236s ≈ low-speed beklemesi → **muhtemelen HEP low-speed'deyiz** (kredi bitti, sınırsız-yavaş mod).
- **Pacing tasarımı bu gerçeğin üstüne kurulacak:** low-speed KALICI durumsa "fren sinyalinde geri çekil"
  mantığı yanlış olur (hep frendeyiz) — asıl soru **B testi**: low-speed'de paralel iş toplam süreyi
  düşürüyor mu, yoksa hepsi bölüşüp aynı yere mi çıkıyor?

**C EK BULGU:** probe'da `onProcessingVideoNum=5` görüldü (çakışan koşulardan) → **sunucu 4'ten fazlasına
izin veriyor**; `MAX_QUEUE=4` bizim varsayımımız, gerçek limit >4 (ve bilinmiyor).

**B) Paralellik gerçek mi (M1'in temel varsayımı) — ÖLÇÜLÜYOR:**
- Sıralı 1-iş X s/video vs paralel N-iş Y s. **Y/N < X → paralellik gerçek, M1 yaşıyor** (kazanç X/(Y/N)).
  Y/N ≈ X → sabit kapasite, **M1 İPTAL**.
- Matematik dikkat: ekranda 2 iş paralel ikisi de "3min" → **1.5 dk/video**; sıralı ~236s ≈ 4dk/video →
  paralel HIZLI OLABİLİR. "Kuyrukta bekleme" ≠ "üretim"; N iş aynı anda üretilirse her biri yavaşlasa da
  toplam çıkış artabilir. (Önce "1→3dk = sabit kapasite" denmişti — hatalı, per-video'yu N'e bölmüyordu.)
- ⚠️ Sunucu yoğunluğu değişken → **sıralı-paralel-sıralı-paralel dönüşümlü** koş, tek ölçüme güvenme.
- **2 vs 3 vs 4 iş → doyum nerede?** `MAX_QUEUE=4` varsayımdı; gerçek optimum bu testten. Poll'daki low-speed
  bilgisini de kaydet (kaç iş low-speed, kaç dk) → kapasite paylaşımını gösterir.
- Ayrı script, progress'e yazma, aynı görsel+prompt.

**✅ B SONUCU — M1 YAŞIYOR ama TAVAN ~2× (17 Tem, 6 tur / 0 çöküş, kuyruk↔üretim ayrımıyla):**
| N | per-video | üretim ort | ls_peak | kazanç |
|---|---|---|---|---|
| 1 (taban) | ~201s | ~160s | 0-1 | — |
| 2 | 126s | 168s | **2/2** | 1.60× |
| 3 | 153s | 164s | **2/3** | 1.31× (straggler gürültüsü) |
| 4 | 114s | 168s | **2/4** | 1.76× |
- **Üretim süresi N'den BAĞIMSIZ (~165s sabit)** → işler GERÇEKTEN paralel üretiliyor (sabit-tek-kapasite değil).
- **ls_peak hep 2** → aynı anda ~2 iş ÜRETİLİYOR, fazlası kuyrukta (low-speed) bekliyor → **kazanç tavanı ~2×.**
- **KARAR: M1 = değer ama mütevazı (~1.6-2×, 3× değil).** Optimal uçuşta-iş **2-3**; `MAX_QUEUE=4` üst sınır ok.
- **→ Tasarım (b) haklı:** submit'i poll/download'dan ayır + pacing'i gönderim-sonrasına taşı+kısalt (~20-60s
  rastgele) → ~2 iş sürekli üretimde tutulur → ~1.6-2× hız + pacing'in %26 ölü zamanı da gider. Firefly'da yok.

**✅ STAGE 2b CANLI (concurrency=2, karışık 2.0+2.3, 6 sahne, 18 Tem — koşu-içi ölçüm):**
- **peak_generating = 2** (karışık batch'te bile) → **2.0/2.3 AYRI YUVA YOK; tavan hâlâ 2** (7. madde: kullanıcı
  hipotezi tavan anlamında DOĞRULANMADI). concurrency=2 optimal; 3-4 ekstra kazanç vermez (yuva yok, kuyrukta bekletir).
- **ÖLÇÜLEN:** peak_generating=2 (aynı anda 2 iş üretiliyor) → **paralellik ~2× tavanlı, GERÇEK**. wall-clock
  757s (6 iş), per-video üretim ~237s (B'de 165s — bugün yüksek/yoğun; oranı bozmaz, ikisini eşit etkiler).
- **TAHMİN (ölçülmedi, sıralı taban koşulmadı):** sıralı+kısa-pacing ~1622s → ~2.1×; sıralı+eski-pacing ~1997s
  → ~2.6×. **Bunlar tahmin, ölçüm DEĞİL.** Kesin olan: peak_gen=2 + üretim örtüşmesi. Toplam muhtemelen ~2-2.6×
  (üst uç tahmin). Pacing AYRI kaldıraç (paralelliğin dışında, ekleniyor).
- **bot sinyali YOK** (popUp:false, serverAlert:0, low-speed 0). **progress bütünlüğü:** 6/6 kayıt sağlam, paralel
  yazım bozulma/kayıp yok (ProgressStore tek-yazıcı+atomik doğrulandı). 1 transient 2400001 (scene_006, Pool bug'ı değil).
- **Bileşenler tamam+test:** `progress.py` (atomik PID-tmp + ProgressStore), `pool.py` (ThreadPool+gate+on_submit+
  hata izolasyonu), `runner._run_pool` + `--concurrency`. Stage 2a: c=1 sıralıya denk (kill/resume kazara doğrulandı).
- **✅ STAGE 2c TAMAM (18 Tem) — M1 BİTTİ:**
  - **Hailuo default concurrency=2** (cli.py; `--concurrency` ile ez; Firefly None=sıralı, Adobe tek-video).
    Canlı doğrulandı: bayraksız Hailuo koşusu `[POOL] concurrency=2` veriyor.
  - **Transient 2400001 retry** (`_retry_structural`, S4'ten AYRI katman — 2400001 structural sınıfı S4'e hiç
    girmez): sınırlı **2 deneme** (3s,6s) + her deneme `[UYARI-2400001]` (gürültülü) + tükenirse "muhtemelen
    YAPISAL" temiz error (sonsuz döngü YOK). Yapısal sebepler (2.3 both, 10s+1080) zaten upstream önlendi;
    3. yapısal çıkarsa retry onu 2'de bırakıp bildirir (kör maskeleme yok). Stub: transient→geçer,
    yapısal-benzeri→2'de durur+uyarır, moderation(2400002)→S4 (çakışma yok), other(SSL)→dışarı. Hepsi geçti.
  - **Q1 (scene_006 2400001):** TRANSIENT doğrulandı — sıralı geçti + aynı 6-batch c=2 tekrar 6/6 (tekrarlamadı).
    Paralellik tetiklemiyor. Artık transient 2400001 auto-retry ile kendini kurtarır.
- **M1 ÖZET:** progress atomik+tek-yazıcı (cross-process) · Pool (ThreadPool+gate+on_submit+hata izolasyonu) ·
  Hailuo default paralel ~2× (peak_gen=2 ölçüldü) · pacing 20-60 ayrı kaldıraç · transient 2400001 self-heal.
  KALAN ÖLÇÜM (opsiyonel): tam batch canlı c=2 net kazanç; optimizer (useOriginPrompt) hız/kalite (L1/HIZ).

**🔑 KÖK KAVRAYIŞ — pacing YANLIŞ YERE KONMUŞ (M1 gerekçesini değiştirir):**
- **Özgün tasarım:** pacing bir **GÖNDERİM ARALAYICISI** olacaktı: gönder → 90-140s bekle → gönder
  (**ilk iş hâlâ üretimdeyken**). Böylece kuyruk dolar, işler PARALEL üretilir, `wait_for_queue` 4'te frene
  basardı. **Paralellik bu tasarımın doğal sonucuydu.**
- **Kodun yaptığı:** gönder → **poll (236s) → indir** → 90-140s bekle → gönder. Pacing tam döngünün SONUNA
  konmuş → **tamamen sıralı**. Bu, bugünün TÜM ölçümlerini açıklıyor: kuyruk hiç dolmadı (73/75 N=0),
  `wait_for_queue` hiç ateşlemedi, `MAX_QUEUE=4` hiç test edilmedi (sunucu 5'e izin verdi), pacing amacını
  kaybedip **%26 ölü zaman** oldu.
- **→ M1 YENİ ÖZELLİK DEĞİL — özgün tasarımın hayata geçmemiş hali.** Paralellik spekülatif fikir değil,
  KAYBOLMUŞ TASARIM NİYETİ.

**PACING'İN ÜÇ AMACI (hepsi korunmalı):** (1) gönderim aralama, (2) kuyruk kontrolü, (3) **bot koruması**
(insan-benzeri rastgele düzensizlik). KRİTİK: bot koruması **gönderimler-arası düzensizlikten** gelir,
döngü-sonu beklemesinden DEĞİL. Şu anki yerde (iş bittikten sonra) gönderim aralığı zaten devasa
(~236s üretim + 90-140s) → bot koruması buradan gelmiyordu, üretim süresi zaten aralıyordu.

**PACING KARARI — B testi seçer:**
- **(a) Pacing'i SİL** → sıralı, ölü zamansız → %26. **ZAYIF:** bot korumasını (3) da siler. Tercih değil.
- **(b) DOĞRU: pacing'i gönderim sonrasına taşı + submit'i poll/download'dan AYIR** → özgün tasarım →
  kuyruk dolar (paralellik) + gönderimler-arası hâlâ rastgele (bot koruması korunur) + `wait_for_queue`
  gerçek fren (İLK KEZ ateşler). **(b) = M1.** Üç amaç da korunur.
- **B testi iki soruyu birden cevaplıyor:** "M1 yazılsın mı" + "pacing nereye konsun".

**Tasarım (b) detayı — B olumluysa:**
- Submit'i poll/download'dan AYIR (paralel submit, bağımsız poll).
- Pacing'i gönderim sonrasına taşı, **rastgele kalsın (bot koruması)** ama **KISALT** (örn. 20-60s — üretim
  236s olduğundan kuyruk yine dolar).
- `wait_for_queue` gerçek fren. Yeni koşuda **popUp/serverAlert/feedMessage İZLE** → bot sinyali gelirse pacing uzat.
- Destek: 75+ generate'te `popUp:false`, `serverAlert:0` → hiç bot sinyali yemedik; "low-speed" iş modeli,
  bot koruması değil → **mevcut davranışımız fazlasıyla temkinli.**
- (Firefly'da GEÇERSİZ — Adobe tek-video, sıralı kalır.)

**C) `wait_for_queue` eşiği `MAX_QUEUE=4` — ÖLÇÜM DEĞİL VARSAYIM.** Kodda tek gerekçe yorumu:
"Kuyrukta max bu kadar video olsun". Bu koşuda kuyruk zaten 2'yi geçmedi → gerçek limit bilinmiyor.
Hailuo'nun gerçek eşiği kaç? Yoğunluğa göre **dinamik** mi olmalı (2-6)? B ölçümü bunu da besler.

## Hailuo paralel üretim (ARAŞTIRMA notu, kod yazılmadı)

Hailuo aynı anda birden fazla iş kabul ediyor (`wait_for_queue` zaten kuyruk<4 mantığında).
**Fikir:** sahneleri tek tek generate→poll→indir (sıralı) yerine, **kuyruk dolana kadar paralel
generate** et; her `vid_id`'yi **bağımsız poll** et (my-work-detail vid_id ile çalışıyor, proje
bağımsız); hangi video önce biterse **hemen indir (out-of-order)**. Tahmini **3-5x hızlanma**.

**DİKKAT:** Mevcut `PACING` (sahne-arası 160-400s) SIRALI akışa göre tasarlandı; paralel modda
bu uzun beklemeler mantıkla çelişir (kuyruk zaten <4 ile sınırlı). Paralel moda geçilirse pacing
YENİDEN düşünülmeli — muhtemelen "generate serpiştirme" (küçük jitter, örn. 8-20s) + `wait_for_queue`
yeterli, uzun sahne-arası bekleme kalkar. **Firefly'da GEÇERSİZ** (Adobe tek-video limiti; sıralı kalır).
Tam batch koşusundan sonra değerlendirilecek.

## M1 MİMARİ PLAN — Aşama 2 (KOD ÖNCESİ, onay bekliyor)

**Ölçülen taban (B testi):** paralellik gerçek, tavan ~2× (ls_peak=2, tek model). Kazanç ~1.6-2×.
Aşama 1 (pacing 20-60s) ~%17-26 ayrı kazanç. Hedef: ~2.4×.

**AKIŞ DEĞİŞİMİ:** `submit` ↔ `poll+download` AYRILIR. Şu an adaptör `submit()` üçünü tek blokta yapıyor →
sıralı. Yeni: N iş **paralel submit** (kuyruk müsaitken) → her `vid_id` **bağımsız poll** → biten **hemen indir**.

**1. PROGRESS YARIŞ KOŞULU (en kritik — çözülmeden Aşama 2 YAZILMAZ):**
- Sorun: `save_progress` TÜM dosyayı yazıyor; iki iş aynı anda yazarsa kayıt kaybolur → **vid_id kaybolur** →
  bugün kurduğumuz kayıp-video mekanizması boşa gider.
- **Çözüm: TEK YAZICI + ATOMİK yazma.** Worker'lar progress'e DOĞRUDAN yazmaz; güncellemeyi bir **kuyruğa**
  koyar (`{out_name: record}`). Tek "owner" kuyruğu boşaltır, bellekteki dict'e merge eder, **tmp dosya +
  `os.replace`** ile atomik yazar. Böylece: (a) yarış yok (tek yazıcı), (b) crash-safe (atomik). Kilit gerekmez.
- vid_id (on_submit) da AYNI kanaldan geçer → asla kaybolmaz.

**2. İŞ HAVUZU = AYRI KATMAN (runner'a gömülü DEĞİL — L2.5 aynı havuzu kullanacak):**
- `Pool`: jobs alır, kapasiteye kadar (`wait_for_queue`/ölçülen tavan) paralel submit eder, her işi bağımsız
  poll+download eder, sonucu callback ile bildirir. Runner VE L2.5 bunu ÇAĞIRIR; Pool runner içini bilmez.
- Arayüz taslağı: `pool.run(jobs, on_result, on_submit)`. Provider-agnostik iskelet; **Firefly'da concurrency=1**
  (Adobe tek-video) — aynı Pool, farklı tavan.

**3. S4 PARALELDE:** S4 zaten iş-başına (`_generate_guarded`). Pool her işi kendi S4 zinciriyle bağımsız koşar →
bir iş soften'a girerse diğerleri devam eder. S4 mantığı DEĞİŞMEZ, sadece her iş ayrı worker'da.

**4. HATA İZOLASYONU:** bir iş patlarsa sonucu "failed" olur (`_record_failure` progress-kanalından), havuz
DEVAM eder. Tek patlama havuzu durdurmaz (workflow `parallel()` semantiği).

**5. İPTAL/KESİNTİ — iş-başına on_submit:** her iş KENDİ `on_submit`'ini alır, submit olur olmaz vid_id'yi
progress-kanalına yazar. Kesintide N işin hepsinin vid_id'si kayıtlı → resume hepsini kurtarır. (Bugün sıralı
kuruldu; paralelde her worker kendi callback'ini çağırır, tek-yazıcı serileştirir.)

**6. MÜKERRER RİSKİ — my-work uzlaştırması ZORUNLU (opsiyonel DEĞİL):**
- **Maliyet değişti:** sıralı akışta çöp video panelde dururdu, zararsız. Pool'da ls_peak=2 → sadece 2 üretim
  yuvası; bir mükerrer yuvaların YARISINI çalar = **doğrudan hız kaybı**. Artık sıfır maliyet değil.
- `submit attempts=1` mükerreri ÇÖZMEZ, bir tur erteler: SSL POST cevabını öldürüp sunucu işi aldıysa, iş
  "retry" işaretlenir → sonraki turda yeniden gönderilir = **yine mükerrer**.
- **ZORUNLU uzlaştırma:** submit başarısız GÖRÜNÜRSE, yeniden denemeden ÖNCE `processing` listesine bak (zaten
  çağırıyoruz, ek istek yok): bu iş için orada bir kayıt var mı → **VARSA vid_id'yi benimse, yeniden submit ETME**.
  - Eşleştirme: processing feed'inde `commonInfo.createTime` (son ~30-60s içinde) + bize ait olmayan vid_id +
    (mümkünse) `feedMessage`/desc'te prompt izi. Kesin eşleşme yoksa: submit'ten hemen önce/sonra
    `onProcessingVideoNum` deltası (0→1) yeni işi işaret eder → o vid_id benimsenir. (Eşleştirme detayı Stage 2'de
    netleşecek; ilke: **şüphede yeniden submit etme, uzlaştır.**)

**7. ÖLÇÜM (Aşama 2 bring-up'ta, tavanı değiştirebilir): 2.0 ve 2.3 AYRI kuyruk yuvası mı?** B testi tek model
ölçtü (ls_peak=2). Karışık batch (2.0-both + 2.3-start eşzamanlı) → ls_peak 2'yi aşıyor mu? Aşarsa gerçek
eşzamanlılık >2 → kazanç tavanı yükselir. Kullanıcı gözlemi destekliyor. Pool'u sonlandırmadan ölç.

**Aşama sırası:** (1) progress atomik+tek-yazıcı [ÖNCE, tek başına test] → (2) Pool iskeleti + tek-iş (sıralıya
denk, regresyon) → (3) N=2 paralel + ölç → (4) 2.0/2.3 karışık ölç → (5) tavan+pacing ayarı. Her aşama stub+canlı.

**POOL İSKELET KARARLARI (onaylı, (A) = submit() bütün olarak thread'de):**
- **wait_for_queue ÇİFT FREN = kilitlenme riski (kritik):** wait_for_queue **kendi işlerimizi de sayıyor**
  (onProcessingVideoNum panele bakar) → N=4'te 4 worker aynı sayaçta bekler, **kendimizi bloke ederiz**.
  → **Pool modunda wait_for_queue ATLA** (`job.skip_queue_gate=True`); semaphore/ThreadPool(N) **birincil ve
  tek fren**. Stage 2b'de ölç: worker'lar takılıyor mu? (Tek shared Pool → "başka biz" yok; panel çakışması nadir.)
- **on_submit META'sı (resume kritik):** bugün runner._on_submit closure'ı out_name/adapter/model_tag/variant/
  scene/mode yakalayıp TAM submitted kaydı yazıyor. Pool'da bu meta **`job.submit_meta`** ile taşınır →
  `store.set_submitted(job.out_name, vid, job.submit_meta)`. Eksikse submitted kaydı bozulur → **resume çalışmaz**.
- **PACING = GLOBAL SUBMIT KAPISI (en kritik):** N worker aynı anda submit ederse pacing kaybolur → 4 istek
  birden → tam kullanıcının gördüğü yığılma ("peş peşe → 4dk bekle"). → **`Pool._gate`**: son GENERATE'ten
  ≥X sn (rastgele 20-60, Aşama 1 değeri) geçmeden yenisi gitmez; worker'lar kapıdan **tek tek** geçer. Adaptör
  generate'ten hemen önce `job.pre_generate()` çağırır (upload'dan sonra, generate'ten önce → generate'leri
  precise aralar). Yoksa Aşama 1 boşa gider.
- **ZORUNLU ölçüm (Stage 2b):** karışık batch (2.0-both + 2.3-start_only) → ls_peak 2'yi aşıyor mu → tavan yükselir mi.

## Firefly KREDİ EKONOMİSİ + çözünürlük (KRİTİK — 403'ün kök nedeni)

**403'ün kök nedeni ÇÖZÜNÜRLÜK, Arkose/token DEĞİL** (eski "S5/Arkose/arp-nonce" şüphesi YANLIŞTI, elendi).

**KANIT (2026-07-15):** Bug_Chaos full koşusu scene_022'de (Ray3.14 **1080p**) `403 access_error
"Unauthorized to perform request"` alıp durdu. **Aynı token+arp+nonce ile** scene_014 **Runway
gen4.5 720p** hemen ardından **HTTP 200 üretti** (4.8 MB). → arp/nonce CANLI; 403 = kredi bitince
1080p yetkisiz.

**Adobe promosyon (hesap = Firefly Pro Plus / 10.000 Kredi) — "seçili modeller/çözünürlüklerde
SINIRSIZ oluşturma":**
- Pro Plus'ta **SINIRSIZ (720p'de):** FF Video Model · **Kling 2.5 Turbo** · **Luma Ray 3.14** · **Runway Gen 4.5**.
- **Kredi yalnız:** 1080p **+** liste-dışı model/çözünürlük için.
- Veo 3.1 Fast + Kling 3.0 Standard yalnız **Premium (50.000 Kredi)** → Pro Plus'ta YOK.

**Mevcut payload durumu (model string'leri promosyon adlarıyla eşleşiyor):**
- `ray314.py`: `3.14-ray` @ **1080p (1920×1080)** ← 403'ün suçlusu, 720p'ye çevrilecek.
- `kling25.py`: `kling_v2_5_turbo_pro_i2v` (= 2.5 **Turbo** ✓) @ **1080p (1920×1080)** ← bu da 1080p, kredi
  bitince 403 alması BEKLENİR (henüz test edilmedi; Kling 720p payload'ı için curl gerekebilir).
- `runway45.py`: `gen4.5` (= Gen 4.5 ✓) @ **720p (1280×720)** ← sınırsız, KREDİSİZ ÇALIŞIYOR (kanıtlandı).

**YENİ TAKAS: 720p SINIRSIZ vs 1080p KREDİLİ.** Firefly artık **işçi model OLABİLİR — 720p'de, kredisiz.**
- **Yapılacak:** ray314 (+ muhtemelen kling) 720p'ye çevrilsin. Sabit mi yoksa `--resolution 720p|1080p`
  bayrağı mı (1080p kredi varken kullanılabilsin) → KARAR bekliyor.

## S3 — Upscale katmanı (artık MERKEZİ, sadece Runway değil)

720p sınırsız stratejisi → **tüm çıktı 720p** olacak → upscale artık **merkezi** (yalnız Runway değil,
Ray/Kling/Runway hepsi). Yer: adaptör sonrası post-process (ffmpeg/harici) — `sink.finalize`'dan önce.

- **ARAŞTIR:** Firefly'ın kendi dokümanında **"Videoları Topaz Astra ile yükseltme"** var →
  promosyona **dahil mi**, 720p→1080p için kullanılabilir mi? (dahilse harici upscaler'a gerek kalmaz)
- Fallback (S4) ile bağlantılı: fallback zaten çözünürlük değiştiriyordu; artık taban 720p olunca tutarlı.

**⚠️ YENİ SORUN — aynı videoda KARIŞIK ÇÖZÜNÜRLÜK:**
- **both** sahneler (122'nin 98'i) yalnız **Ray**'e gidebilir (Kling sadece start frame alır, end yok) → **720p**.
- **start_only** sahneler **Kling 1080p**'de kalabilir (Kling Turbo 1080p kredisiz çalışıyor — kullanıcı paneli doğruladı).
- Bugüne kadar üretilmiş **~33 video 1080p** (kredi ile).
- → Aynı videonun sahneleri **720p + 1080p karışık** olacak. **KARAR gerek:**
  - (a) her şeyi **720p'ye indir** (Kling'i de) + gerekirse toplu upscale,
  - (b) 720p'leri **upscale edip 1080p'de birleştir** (S3),
  - (c) **karışık bırak** (kurguda ölçeklenir mi? — araştır).
- **Not (teori inceldi):** model başına sınırsız çözünürlük tavanı FARKLI görünüyor — Kling 2.5 Turbo ≈ 1080p,
  Ray 3.14 ≈ 720p, Runway 4.5 = 720p. Promo tablosunda yalnız "Kling 3.0 Standard (720p)" açık çözünürlük
  notu vardı. **Kullanıcı panelden kredi maliyetini teyit edecek** (Ray @1080p vs @720p, Kling Turbo @1080p kaç kredi).

## Promosyon takvimi + Veo/hesap kararı

- **Promosyon bitişi:** plans.html metadata (`unlimited-go-big-june`) → **~26 Ağustos 2026** (TEYİT EDİLECEK).
  Bitince **her şey krediye döner** → strateji değişir (720p sınırsızlık kalkar).
- **Promo SSS:** "Yükseltme yapmak promosyon bitiş tarihini UZATMAZ."
- **Veo 3.1 Fast = Premium (50.000 Kredi)**, Pro Plus'ta yok → **yeni hesap/paket kararı bunu bilerek**
  verilecek (bkz. "Firefly üst paket + Veo 3.1").

## Firefly PACING — DENEYSEL (canlı ayar)

Firefly `scene`/`variant` beklemesi **8-20s** (önce 4-8s'ti). 12 sahnelik koşuda 4-8s
sorunsuzdu (tek hata 451/moderasyon, hız değil); 122 sahnelik uzun koşuda ihtiyaten
artırıldı. Maliyet ~15-20 dk, kabul edilebilir.

- **429 / rate-limit gelirse** → değeri **artır**.
- **Sorunsuz geçerse** → sonraki koşularda **düşürmeyi dene** (4-8s'e geri).
- Yeri: `runner.PACING["firefly"]`.

**Hailuo PACING — DENEYSEL kısaltma (2026-07):** sahne + varyant **90-140s** (önceden sahne 160-400 /
varyant 120-180). Gerekçe: `wait_for_queue` (kuyruk<4) + heartbeat zaten aşırı yükten koruyor; uzun
random bekleme fazla muhafazakârdı (panel çoğu zaman boş). **Koşuda rate-limit/blok gelirse geri artır.**
Yeri: `runner.PACING["hailuo"]`. (Hailuo'da çözünürlük/kredi meselesi YOK — çıktı 1080p, kredi yakmıyor.)

## Firefly üst paket + Veo 3.1 — İPTAL

Veo çocuk karakter üretimini reddediyor (Google `personGeneration` varsayılanı = yalnız yetişkin;
Dzine testi doğruladı, hata 4716 "declined by our supplier"). BabyBerry'nin her sahnesinde çocuk var
→ Veo adaptörü yapılmayacak, Premium alınmayacak.

## S4 — Moderasyon (451) fallback zinciri — ERTELENDİ (Veo 3.1 ile birlikte)

**Durum: ERTELENDİ** → **Veo 3.1 adaptörü eklenirken birlikte yapılacak.**
Gerekçe: yeni Firefly hesabı + Veo 3.1 gelince model havuzu değişecek; fallback zincirini
o zaman **tek seferde, tüm modelleri kapsayacak** şekilde kurmak doğru. Şimdi Kling→Runway
kurup Veo için elden geçirmek **iki kere iş** olur.

**Kanıt (elde):** moderasyon **model-bazlı** — Kling'in 451 verdiği prompt+keyframe'i **Runway
kabul etti** (scene_008 deneyi, 7.4 MB temiz üretim). **Prompt yumuşatma gerekmedi.**

**HATA KODU AYRIMI (Hailuo kodları ayırıyor — kanıtlandı, fallback bunu kullanmalı):**
- **Hailuo `2400002`** ("Text content violated Community Guidelines") = **MODERASYON** → retry (2×) →
  prompt yumuşatma (3×) → error+rapor. (Waterpark scene_052; SSL hatası bunu maskelemişti.)
- **Hailuo `2400001`** ("Content generation error, please regenerate") = **YAPISAL** (RQ2: 2.3 both reddi) →
  **yumuşatma TETİKLENMESİN** (boşa gider), doğrudan `error`.
- **Firefly `451`** = **MODERASYON** (aynı zincir) — ama **deterministik DEĞİL** (scene_008 retry'da geçti) →
  önce basit retry, sonra model fallback.

**MODERASYON İKİ TÜRLÜ (canlı kanıt — soften'ın gerçekten gerekli olduğunu gösterir, teorik değil):**
- **(a) Sınırda:** scene_008 (Firefly 451) 2 kez takıldı, 3'üncüde geçti → **retry kurtarır**.
- **(b) Deterministik:** scene_052 (Hailuo 2400002) retry×2'de **hiç geçmedi** → yalnız **soften veya elle
  revizyon** kurtarır. Prompt: `"[Static shot] The baby sits at the top of the colorful slide..."` —
  muhtemelen "bebek kaydırağın tepesinde" güvenlik sinyali tetikliyor.
- **Durum:** S4 TAM DOĞRULANDI (classify+retry+soften+fallback+softened izi; classify 10/10, zincir 6/6).
  **CANLI soften ✓ (scene_052):** 2400002 → retry×2 (yine 2400002) → **soften#1 Claude çağrıldı → geçti** →
  vid_id 534208621274927108 → done, `softened:true` + `soften_attempt:1` + final_prompt progress'te,
  özette `⚠ softened=1`. Yumuşatma niyeti korudu (baby→toddler, toothless→happy; sahne/kamera/stil aynı).

**Tasarım (yapılacak):**
- **Tam fallback zinciri** — moderasyon (451/2400002) verirse **sıradakine düş** (Kling → Runway → Veo → ...).
  Sıra/yön kararı **model havuzu netleşince**.
- **İkinci kademe:** hepsi reddederse **prompt yumuşatma** (Claude/Gemini ile yeniden yaz) — yalnız moderasyonda.
- **Üçüncü kademe:** `error` + net rapor (sahne, model, prompt, keyframe).

**Dikkat:**
- Fallback **çözünürlük değiştirir** (Runway 720p vs Kling 1080p) → progress'te **fallback işareti**
  + **S3 (upscale)** ile bağlantılı.
- Fallback **yalnız 451'de** tetiklensin (başka hata değil).

**Bilinen maliyet (mevcut Bug_Chaos full koşusu):** ~12 kling sahnesinin **2-3'ü 451 alıp `error`
kalabilir** (ilk 12'de 4 kling'den 1'i takılmıştı, ~%25). **Kabul edildi** — koşu sonrası elle
Runway'e verilir.

## Scene Studio'ya Firefly GÖRSEL (image) modelleri — AYRI İŞ (video DEĞİL, Scene Studio/L2)

**Karıştırma:** bu video üretimi değil, **keyframe hazırlama/düzenleme** katmanı.
Scene Studio şu an face-swap için **Dzine AI** kullanıyor. Yeni üyelikten sonra Firefly'ın
**görsel (image) modelleri** de Scene Studio'ya eklenecek — Dzine'a alternatif/ek.

- **Ayrı token:** Firefly **image endpoint'i** video endpoint'inden farklı olabilir →
  ayrı curl/token yakalama gerekir.
- **Ayrı sistem:** Scene Studio = browser tabanlı HTML (Vercel/Node); video_router = Python.
  **İki ayrı sistem, token'lar ayrı yönetilecek.** Bu iş **video_router'ın DIŞINDA** (L2).

> Net ayrım: **(1) video üretimi** = video_router + yeni adaptör (Veo 3.1).
> **(2) görsel düzenleme** = Scene Studio, ayrı proje/token.

## start_only model seçimi (KARAR — uygulandı)

Varsayılan **Kling** (1080p, güvenli). `--start-model kling|runway|alternate`; bayrak
yoksa firefly'da video başında BİR KEZ sorulur (varyant sorusuyla aynı yer). Sahne
bazında tek tek SORULMAZ. hailuo start_only tek seçenek (2.3) olduğu için sorulmaz.

## L2.5 — Lokal job API + ince UI (online'a KÖPRÜ)

**Fikir:** video_router'ın önüne bir **FastAPI job servisi** koy, üstüne **ince HTML/JS arayüz**.
**Kritik nokta:** asıl iş UI değil, **altındaki API**. Bir kez yazılır, **üç tüketici** çağırır:
1. Lokal HTML sayfası,
2. VPS'e deploy + auth = **online panel (L3)**,
3. Scene Studio'nun **"Video Üret" sekmesi** (birleştirme hedefi (b)).

Böylece **"lokal → online" geçişi gerçekten sadece deploy + auth** olur.

**Dil kararı:** **Python/FastAPI** (Node değil) — video_router zaten Python, köprü gerekmez.
Scene Studio (Node) ileride **HTTP ile** çağırır. Desen zaten var: `babyberry_ui` (FastAPI).

**İKİYE AYIR:**

- **(a) İnce izleme/başlatma UI'ı** — proje seç, varyant/model seç, batch başlat, **canlı ilerleme**
  (kaç/kaç, hangi sahne, hangi model, hata var mı), üretilen videoyu **inline izle**.
  **M2/L1'den bağımsız** (onlar değişse de bozulmaz). **Değeri:** kullanıcı Claude Code'dan bağımsız
  çalışabilir (şu an her koşu için aracı gerekiyor) + bugünkü **görünürlük sorununu** (log buffer,
  "panel boş mu çalışıyor mu") çözer. **ERKEN yapılabilir.**
- **(b) Asıl panel** — **M2'den SONRA.** Sahne bazlı override (prompt düzenle, frame_mode değiştir),
  tek sahne yeniden üret, varyant karşılaştırma. **M2 kararıyla örtüşür:** önce local CLI'da override,
  panel onu kullanır.

**Mimari uyarı:** Bu, runner'ı CLI prosesinden **uzun ömürlü servise** çevirir — iş kuyruğu,
eşzamanlı koşu yönetimi, `progress.json → job state`, proses gözetimi/iptal. **Küçük iş değil**,
ama doğru yapılırsa **online geçişi bedavaya gelir**.

**Token deseni:** Scene Studio'nun modeli **birebir taşınacak** (üst bar alanı → localStorage →
header → sunucu `.env` fallback, JWT `exp` gösterimi). Firefly ~12-24h ömürlü → UI'da
**"token X saat sonra dolacak"** uyarısı değerli.

**Sıra önerisi:** L1 → M2 → **L2.5(a+b)** → deploy = L3.
**Ama (a) L1'den ÖNCE de yapılabilir** (bağımsız, ucuz, günlük operasyonu rahatlatır).

## Online panel katmanı (Vercel/web — ileride, kod yazılmadı)

Local aşamada dosyalar (token/cookie/project `.txt`) yeterli. Online panele geçişte:

1. **Model başına token girme alanı** — kullanıcı F12'den kopyalayıp panele yapıştırır;
   sistem saklar ve "sürekli güncellenebilir" olur (her model: Firefly token/arp/nonce,
   Kling/Runway arp/nonce, Hailuo token/cookie/project).
2. **Güvenlik/auth** — panele giriş password/auth ile korunmalı (başka personel de kullanacak).
   Token'lar saklanırken **şifreli (encryption)** tutulmalı, düz metin değil.
3. **Çok kullanıcı yetkilendirme** — kim token girebilir / kim üretim başlatabilir ayrımı (rol bazlı).

> Not: local `core.OutputSink` / token okuma katmanı, ileride bu paneldeki şifreli
> depodan besleneceği düşünülerek soyut tutuluyor.

## Override katmanı — ÇOKLU ALAN (tasarım notu)

Override mekanizması **aynı sahnede birden fazla alanı aynı anda** değiştirebilmeli
(örn. `frame_mode` + `prompt` beraber). Tek-alan override değil; sahne bazında
alan-alan üzerine yazan (merge) bir katman olarak tasarlanacak. Bu, hem manuel
düzeltmeleri hem de katmanlar arası (prompt üretimi → video üretimi) ince ayarı
tek yerde toplar.

**Kullanım senaryosu:** kullanıcı bir sahneyi beğenmezse **yalnız o sahne** yeniden üretilsin —
prompt'ta değişiklik (ekle/çıkar/değiştir) veya frame_mode override ("sadece start frame ile üret").

**KARAR — yer:** M2 **önce LOCAL CLI'da** yapılacak (`overrides.json` + `--force` + revizyonlu
dosya adı, ör. `scene_035_kling_v1_r2.mp4`). Online panel (L3) **bu CLI katmanını kullanacak** —
panelde sıfırdan yapmak L3'ü şişirir. Yani override zekası local'de, panel sadece arayüz.

## Scene Studio entegrasyonu (L2/L3) — mevcut altyapı zaten yarısını çözmüş

Scene Studio (**Next.js 15 + React 19 + Tailwind**, Vercel'de canlı; Express fallback + Docker)
online panel/L3 gereksinimlerinin **yarısını zaten çözmüş** — bunlar **sıfırdan yapılmayacak,
buradan taşınacak**:

- **Auth:** `APP_PASSWORD` + `AUTH_SECRET`; HMAC-SHA256 imzalı `studio_session` çerezi
  (`base64url(payload).hmac`, 7 gün, timing-safe, HttpOnly/SameSite=Lax). `checkProxyAuthorized` deseni.
- **Token girme alanı (ARADIĞIMIZ DESEN):** Dzine JWT → üst bar alanı → `localStorage`
  (`scene_studio_dzine_token`) → `X-Dzine-Token` header → yoksa sunucu `.env DZINE_TOKEN` fallback.
  JWT `exp` parse edilip durum gösteriliyor. **Firefly/Hailuo token'ları için birebir bu model.**
- **Proxy deseni:** anahtarlar sunucuda, istemciye gömülmüyor.
- **Eksik:** token'lar `.env`/localStorage'da **düz metin** — ROADMAP'in "şifreli depo" + rol bazlı
  çok-kullanıcı gereksinimi **hâlâ açık** (bkz. Online panel katmanı).

**Deploy KARARI — video_router VERCEL'E GİTMEZ:** koşular 4-5 saat (serverless süre limiti),
disk kalıcılığı şart (progress.json, token dosyaları, inen mp4). Doküman da "büyük/uzun işler için
VPS/Docker" diyor. **Hedef: video_router → Hetzner VPS (zaten var, CPX42).** Scene Studio Vercel'de
kalabilir veya aynı VPS'e taşınır — karar sonra.

**Birleştirme seçenekleri:**
- (a) Ayrı kalsın, JSON sözleşmesiyle konuşsunlar (mevcut durum).
- (b) **[ÖNERİLEN HEDEF]** Scene Studio UI + VPS'te Python worker — Studio'ya **"Video Üret" sekmesi**,
  iş atar + ilerleme gösterir.
- (c) Yeniden yazım (HAYIR).

**SÖZLEŞME UYUMSUZLUĞU — ARAŞTIR (L2 öncesi, sessiz kırılma riski):** Doküman `frame_mode: first|last|both|none`
diyor; video_router/gemini `start_only|end_only|both` kullanıyor (Waterpark JSON'unda `start_only` vardı).
Doküman mı eski, bir yerde eşleme mi var, Studio sürümü mü değişti? **L2 öncesi netleşsin.**

> Öncelik değişmedi: önce lokalde eksiksiz (katman 1 ✓ → L1 → M2 → L2), online en son.

> Bu belge canlı tutulacak; her katman tamamlandıkça işaretlenip güncellenecek.
