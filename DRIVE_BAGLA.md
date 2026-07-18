# Google Drive → L2.5 (Vercel)

Panel canlıda Drive kökündeki **proje klasörlerini** listeler; worker koşuda dosyaları çeker.

## Drive klasör düzeni

```
L2_Videos/                          ← KÖK (bunun ID'si = L2_DRIVE_ROOT_ID)
  ice_cream_truck/                  ← her video bir klasör
    Ice cream truck - German.mp4
    *_scenes_manual.json            ← Studio / L2.5'e gönder
    keyframes/...
  baska_proje/
    ...
  _l2_jobs/                         ← otomatik (kuyruk)
```

Kök ID (PR1): `1FaV5E7CBf1e_8sfj-NbKhdM-ILKm0yRn`  
https://drive.google.com/drive/u/3/folders/1FaV5E7CBf1e_8sfj-NbKhdM-ILKm0yRn

Altında: ice_cream_truck, bug_chaos, Traffic rules - German, … (her biri bir proje klasörü).

## 1) Service account (bir kez)

1. https://console.cloud.google.com → proje seç/oluştur  
2. **APIs & Services → Enable APIs** → **Google Drive API** aç  
3. **IAM → Service Accounts → Create**  
4. Key → JSON indir → bu klasöre koy: `service-account.json`  
5. JSON içindeki `client_email` adresini Drive **kök** klasöründe **Editor** olarak paylaş  

## 2) Bu script ile Vercel'e bağla

PowerShell (repo kökünde):

```powershell
.\scripts\set_vercel_drive.ps1 -DriveRootId "DRIVE_KOK_KLASOR_ID" -ServiceAccountPath ".\service-account.json"
```

Script: env yazar + production redeploy eder.

## 3) Kontrol

https://l2-panel-three.vercel.app/health  
→ `"runtime":"cloud"`, `"drive":true`

Panelde projeler Drive'dan görünür.

## 4) Worker (üretim için)

```powershell
$env:L2_RUNTIME="cloud"
$env:L2_DRIVE_ROOT_ID="..."
$env:GOOGLE_APPLICATION_CREDENTIALS=".\service-account.json"
python -m l2_panel.worker
```
