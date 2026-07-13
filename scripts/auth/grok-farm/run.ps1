# Windows helper — prefer WSL/Linux VPS for production farm (Camoufox + Turnstile).
# Usage:
#   .\run.ps1 --diagnose
#   .\run.ps1 -n 5 -c 1 -y
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".venv")) {
  Write-Host "Missing .venv — create: python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt; python -m camoufox fetch"
  exit 1
}
& .\.venv\Scripts\Activate.ps1
if (-not (Test-Path ".env")) {
  Write-Host "Missing .env — copy .env.example to .env and edit"
  exit 1
}
python farm.py @args
