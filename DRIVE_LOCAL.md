# Google Drive (yerel senkron)

Uretilen videolar ve proje dosyalari varsayilan olarak `./projects/` altina yazilir.
Google Drive for Desktop ile bu klasoru bulutta senkron tutabilirsin.

## Bu makine (L2 Generated)

Google Drive klasoru: [L2 Generated](https://drive.google.com/drive/u/0/folders/1G8lTM4PnXJmThwrWpKlaP1bUOpnVKo3k)

Yerel senkron yolu:

```
C:\Users\LENOVO\Desktop\L2 Generated
```

`.env.local`:

```
L2_PROJECTS_ROOT=C:\Users\LENOVO\Desktop\L2 Generated
```

## Kurulum (bir kez)

1. [Google Drive for Desktop](https://www.google.com/drive/download/) kur.
2. Repo kokunde:

```powershell
.\scripts\setup_drive_projects.ps1
```

Drive yolu farkliysa:

```powershell
.\scripts\setup_drive_projects.ps1 -DriveParent "G:\My Drive"
```

Mevcut `./projects/` icerigini de tasimak icin:

```powershell
.\scripts\setup_drive_projects.ps1 -MoveExisting
```

3. Paneli yeniden baslat:

```powershell
npm run dev
```

4. Kontrol: http://localhost:3000/api/health  
   `projects_root` -> `...\L2_projects` ve `drive_sync: true` olmali.

## Ne olur?

| Dosya | Konum |
|-------|--------|
| Scenes JSON, keyframes, video | `L2_projects/<proje>/` |
| Uretilen MP4 | `L2_projects/<proje>/<proje>_output/videos/` |
| Log, fail lessons | ayni proje klasoru |

Drive arka planda senkronlar; panel kodu degismez.

## Elle ayar

`.env.local` (git'e girmez):

```
L2_PROJECTS_ROOT=C:\Users\LENOVO\Desktop\L2 Generated
```
