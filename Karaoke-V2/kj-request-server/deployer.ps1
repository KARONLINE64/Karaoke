# Mise en ligne du serveur des espaces KJ (« karolive-kj ») sur Cloudflare.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\deployer.ps1
#
# A relancer sans risque a chaque mise a jour : la base de donnees et le jeton
# d'administration existants sont conserves. Le serveur actuel des demandes
# (cloudflare-request-server, OpenKJ) n'est jamais touche.
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

# 3) Connexion au compte Cloudflare (celui du serveur cloudflare-request-server).
$who = npx wrangler whoami 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match "not authenticated") {
    Write-Host "Connexion à Cloudflare : une page va s'ouvrir dans le navigateur, cliquez sur « Allow »." -ForegroundColor Yellow
    npx wrangler login
    if ($LASTEXITCODE -ne 0) { Fail "connexion à Cloudflare" }
}

# 4) Base de données « karolive-kj » (créée une seule fois).
function Get-DatabaseId {
    $list = (npx wrangler d1 list --json 2>$null) -join "`n"
    try { $dbs = $list | ConvertFrom-Json } catch { return $null }
    foreach ($db in $dbs) { if ($db.name -eq "karolive-kj") { return $db.uuid } }
    return $null
}
$dbId = Get-DatabaseId
if (-not $dbId) {
    Write-Host "Création de la base de données karolive-kj..." -ForegroundColor Cyan
    npx wrangler d1 create karolive-kj
    $dbId = Get-DatabaseId
}
if (-not $dbId) { Fail "base de données karolive-kj introuvable" }
$toml = Get-Content wrangler.toml -Raw
$toml = $toml -replace 'database_id = "[^"]*"', ('database_id = "' + $dbId + '"')
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "wrangler.toml"), $toml)
Write-Host "Base de données : $dbId" -ForegroundColor Cyan

# 5) Mise en ligne.
Write-Host "Mise en ligne de karolive-kj..." -ForegroundColor Cyan
$deploy = npx wrangler deploy 2>&1
$deploy | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Fail "wrangler deploy" }
$url = ([regex]::Match(($deploy -join "`n"), 'https://karolive-kj\.[a-z0-9-]+\.workers\.dev')).Value
if (-not $url) { Fail "adresse du serveur introuvable dans la réponse de wrangler" }

# 6) Jeton d'administration (KJ_ADMIN_TOKEN) : créé une fois, gardé dans
#    KJ_ADMIN_TOKEN.txt (à garder secret : il servira au serveur karolive.com).
$tokenFile = Join-Path $PSScriptRoot "KJ_ADMIN_TOKEN.txt"
if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
} else {
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').Replace('=', '')
    [System.IO.File]::WriteAllText($tokenFile, $token)
}
$token | npx wrangler secret put KJ_ADMIN_TOKEN
if ($LASTEXITCODE -ne 0) { Fail "enregistrement du jeton KJ_ADMIN_TOKEN" }

# 7) Vérifications.
Start-Sleep -Seconds 5
try { $hello = Invoke-RestMethod "$url/" } catch { $hello = "" }
try {
    Invoke-RestMethod "$url/admin/kj" -Method Post -ContentType "application/json" -Body '{}' -Headers @{ Authorization = "Bearer $token" } | Out-Null
    $admin = "OK"
} catch {
    # Réponse 400 (« invalid code ») attendue : le jeton est accepté.
    $admin = if ($_.Exception.Response.StatusCode.value__ -eq 400) { "OK" } else { "ERREUR $($_.Exception.Response.StatusCode.value__)" }
}
Write-Host ""
Write-Host "=== karolive-kj en ligne ===" -ForegroundColor Green
Write-Host "Adresse : $url"
Write-Host "Réponse : $hello"
Write-Host "Jeton d'administration : $admin (gardé dans KJ_ADMIN_TOKEN.txt)"
Write-Host "Envoyez l'adresse ci-dessus à Claude (pas le jeton)." -ForegroundColor Yellow
