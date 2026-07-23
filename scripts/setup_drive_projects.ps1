# L2.5 - bind projects folder to Google Drive sync path.
# Usage (repo root):
#   .\scripts\setup_drive_projects.ps1
#   .\scripts\setup_drive_projects.ps1 -DriveParent "G:\My Drive"
#   .\scripts\setup_drive_projects.ps1 -MoveExisting

param(
  [string]$DriveParent = "",
  [string]$FolderName = "L2_projects",
  [switch]$MoveExisting
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DefaultLocal = Join-Path $RepoRoot "projects"

function Find-DriveParent {
  $candidates = @(
    (Join-Path $env:USERPROFILE "Desktop\L2 Generated"),
    "G:\My Drive",
    "G:\Google Drive",
    (Join-Path $env:USERPROFILE "Google Drive"),
    (Join-Path $env:USERPROFILE "My Drive"),
    (Join-Path $env:USERPROFILE "GoogleDrive")
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

if (-not $DriveParent) {
  $DriveParent = Find-DriveParent
}
if (-not $DriveParent -or -not (Test-Path -LiteralPath $DriveParent)) {
  Write-Host ""
  Write-Host "Google Drive folder not found." -ForegroundColor Yellow
  Write-Host "Install Google Drive for Desktop, then run:" -ForegroundColor Yellow
  Write-Host '  .\scripts\setup_drive_projects.ps1 -DriveParent "G:\My Drive"' -ForegroundColor Cyan
  exit 1
}

$ProjectsRoot = Join-Path $DriveParent $FolderName
New-Item -ItemType Directory -Force -Path $ProjectsRoot | Out-Null
Write-Host "Projects root: $ProjectsRoot" -ForegroundColor Green

if ($MoveExisting -and (Test-Path -LiteralPath $DefaultLocal)) {
  $items = Get-ChildItem -LiteralPath $DefaultLocal -Force | Where-Object { $_.Name -ne ".gitkeep" }
  foreach ($item in $items) {
    $dest = Join-Path $ProjectsRoot $item.Name
    if (Test-Path -LiteralPath $dest) {
      Write-Host "  skip (exists): $($item.Name)" -ForegroundColor Yellow
    } else {
      Move-Item -LiteralPath $item.FullName -Destination $ProjectsRoot
      Write-Host "  moved: $($item.Name)" -ForegroundColor Green
    }
  }
}

$envFile = Join-Path $RepoRoot ".env.local"
$line = "L2_PROJECTS_ROOT=$ProjectsRoot"
if (Test-Path -LiteralPath $envFile) {
  $content = Get-Content -LiteralPath $envFile -Raw
  if ($content -match '(?m)^L2_PROJECTS_ROOT=') {
    $content = $content -replace '(?m)^L2_PROJECTS_ROOT=.*$', $line
  } else {
    $content = $content.TrimEnd() + "`r`n$line`r`n"
  }
  Set-Content -LiteralPath $envFile -Value $content -NoNewline -Encoding utf8
} else {
  $lines = @(
    "# L2.5 local settings (not committed)",
    "# Created by scripts/setup_drive_projects.ps1",
    $line,
    ""
  )
  Set-Content -LiteralPath $envFile -Value $lines -Encoding utf8
}

Write-Host ""
Write-Host ".env.local updated" -ForegroundColor Green
Write-Host "Restart panel: npm run dev" -ForegroundColor Cyan
Write-Host "Check: http://localhost:3000/api/health" -ForegroundColor Cyan
