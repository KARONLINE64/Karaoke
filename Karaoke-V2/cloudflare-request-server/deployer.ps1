# Mise en ligne du serveur des demandes du KJ propriétaire
# (« cloudflare-request-server » : KaroliveBox Master, page sans ?kj=).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\deployer.ps1
#
# A relancer sans risque a chaque mise a jour : la base « requests », les
# reglages (ALLOWED_ORIGINS) et les jetons existants sont conserves.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

function Fail($message) {
    Write-Host ""
    Write-Host "ECHEC : $message" -ForegroundColor Red
    exit 1
}

# 1) Node.js (fournit npm / npx).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js n'est pas installé. Installation..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Fail "Node.js vient d'être installé : FERMEZ cette fenêtre PowerShell, rouvrez-en une et relancez deployer.ps1."
}
Write-Host "Node.js $(node --version)" -ForegroundColor Cyan

# 2) Outil Cloudflare (wrangler), installé dans ce dossier.
Write-Host "Installation de wrangler..." -ForegroundColor Cyan
npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail "npm install" }

# 3) Connexion au compte Cloudflare (celui de cloudflare-request-server).
$who = npx wrangler whoami 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match "not authenticated") {
    Write-Host "Connexion à Cloudflare : une page va s'ouvrir dans le navigateur, cliquez sur « Allow »." -ForegroundColor Yellow
    npx wrangler login
    if ($LASTEXITCODE -ne 0) { Fail "connexion à Cloudflare" }
}

# 4) Base de données existante « requests » (jamais recréée ici).
$list = (npx wrangler d1 list --json 2>$null) -join "`n"
try { $dbs = $list | ConvertFrom-Json } catch { $dbs = @() }
$dbId = ($dbs | Where-Object { $_.name -eq "requests" } | Select-Object -First 1).uuid
if (-not $dbId) { Fail "base de données « requests » introuvable sur ce compte Cloudflare" }
$toml = Get-Content wrangler.toml -Raw
$toml = $toml -replace 'database_id = "[^"]*"', ('database_id = "' + $dbId + '"')
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "wrangler.toml"), $toml)
Write-Host "Base de données : $dbId" -ForegroundColor Cyan

# 5) Mise en ligne.
Write-Host "Mise en ligne de cloudflare-request-server..." -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Fail "wrangler deploy" }

# 6) Vérification : /status répond et annonce la version du catalogue.
Start-Sleep -Seconds 5
try {
    $status = Invoke-RestMethod "https://cloudflare-request-server.amkoud.workers.dev/status"
    Write-Host ""
    Write-Host "=== cloudflare-request-server en ligne ===" -ForegroundColor Green
    Write-Host ("Page en ligne (logiciel ouvert) : {0} ; version du catalogue : {1}" -f $status.online, $status.catalogVersion)
} catch {
    Fail "le serveur ne répond pas sur /status"
}
