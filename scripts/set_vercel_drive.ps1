# L2.5 — Vercel'e Google Drive env bağla
param(
  [Parameter(Mandatory = $true)][string]$DriveRootId,
  [Parameter(Mandatory = $true)][string]$ServiceAccountPath,
  [string]$IngestToken = ""
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $ServiceAccountPath)) {
  throw "Service account bulunamadı: $ServiceAccountPath"
}

$saJson = (Get-Content -Raw -Path $ServiceAccountPath).Trim()
# tek satır
$saOneLine = ($saJson -replace "\r?\n", " ").Trim()

function Set-VercelEnv([string]$Key, [string]$Value) {
  Write-Host "→ $Key"
  $Value | vercel env add $Key production --force 2>$null
  if ($LASTEXITCODE -ne 0) {
    # bazı CLI sürümlerinde --force yok; kaldırıp ekle
    vercel env rm $Key production --yes 2>$null
    $Value | vercel env add $Key production
  }
}

Set-VercelEnv "L2_RUNTIME" "cloud"
Set-VercelEnv "L2_DRIVE_ROOT_ID" $DriveRootId
Set-VercelEnv "GOOGLE_SERVICE_ACCOUNT_JSON" $saOneLine

if ($IngestToken) {
  Set-VercelEnv "L2_INGEST_TOKEN" $IngestToken
}

Write-Host "`nRedeploy..."
vercel --prod --yes

Write-Host "`nBitti. Health: https://l2-panel-three.vercel.app/health"
Write-Host "JSON client_email'i Drive kök klasörüne Editor olarak paylaşmayı unutma."
