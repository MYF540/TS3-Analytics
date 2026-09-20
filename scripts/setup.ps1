<#
.SYNOPSIS
  Installiert, aktualisiert und steuert TS3 Analytics als Windows-Dienst.

.DESCRIPTION
  Automatisiert die Schritte aus docs/betrieb.md. Der Dienst läuft über NSSM
  (https://nssm.cc/), weil Node.js selbst kein Windows-Dienst ist.

  Befehle:
    install    Abhängigkeiten installieren, bauen, Dienst einrichten
    update     Dienst anhalten, sichern, neu bauen, Dienst starten
    start      Dienst starten und Gesundheitsprüfung abwarten
    stop       Dienst anhalten (laufende Sitzungen werden sauber geschlossen)
    uninstall  Dienst entfernen; Daten bleiben erhalten
    status     Zustand von Dienst, Datenbank und TeamSpeak-Verbindung zeigen

.EXAMPLE
  .\scripts\setup.ps1 install
  .\scripts\setup.ps1 update
  .\scripts\setup.ps1 uninstall -PurgeData

.NOTES
  install, update und uninstall brauchen eine Eingabeaufforderung als Administrator.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'update', 'start', 'stop', 'uninstall', 'status')]
    [string]$Command = 'status',

    # Name des Windows-Dienstes.
    [string]$ServiceName = 'ts3-analytics',

    # Pfad zu nssm.exe, falls sie nicht im PATH liegt.
    [string]$Nssm,

    # Keine Rückfragen stellen.
    [switch]$Yes,

    # Nur bei uninstall: data\ mitsamt Datenbank, Logs und Sicherungen löschen.
    [switch]$PurgeData,

    # Nur bei update: keine Sicherung vor dem Update anlegen.
    [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Das Skript liegt in scripts\, die Anwendung eine Ebene darüber.
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$EnvExample = Join-Path $Root '.env.example'
$LogDir = Join-Path $Root 'data\logs'
$MinNodeMajor = 22

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor Gray }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

function Stop-WithError([string]$Text) {
    Write-Host "FEHLER: $Text" -ForegroundColor Red
    exit 1
}

function Confirm-Action([string]$Question) {
    if ($Yes) { return $true }
    $answer = Read-Host "$Question [j/N]"
    return $answer -match '^\s*[jJyY]'
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin([string]$What) {
    if (-not (Test-Admin)) {
        Stop-WithError "$What braucht eine Eingabeaufforderung als Administrator."
    }
}

# --- Werkzeuge -------------------------------------------------------------

function Get-NodePath {
    # Erst über PATH suchen. Direkt nach einer Node-Installation kennt eine schon offene
    # Sitzung den neuen PATH noch nicht – deshalb die üblichen Installationsorte als Rückfall,
    # damit kein Neustart nötig ist (Hinweis aus dem Produktivbetrieb).
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($node) { $node.Source } else { $null }

    if (-not $nodePath) {
        $roots = @(
            $env:ProgramFiles,
            [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
            [Environment]::GetEnvironmentVariable('ProgramW6432'),
            (Join-Path $env:LOCALAPPDATA 'Programs')
        ) | Where-Object { $_ }
        foreach ($root in $roots) {
            $candidate = Join-Path $root 'nodejs\node.exe'
            if (Test-Path -LiteralPath $candidate) {
                $nodePath = (Resolve-Path -LiteralPath $candidate).Path
                break
            }
        }
    }

    if (-not $nodePath) {
        Stop-WithError 'Node.js wurde nicht gefunden. Node 22 LTS oder neuer installieren (64 Bit).'
    }

    # Den Ordner für diesen Prozess in den PATH nehmen: corepack und pnpm liegen daneben.
    $nodeDir = (Split-Path -Parent $nodePath).TrimEnd('\')
    $inPath = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }) -contains $nodeDir
    if (-not $inPath) {
        $env:Path = "$nodeDir;$env:Path"
        Write-Note "Node-Verzeichnis für diesen Lauf zum PATH ergänzt: $nodeDir"
    }

    $version = (& $nodePath --version).TrimStart('v')
    $major = [int]($version -split '\.')[0]
    if ($major -lt $MinNodeMajor) {
        Stop-WithError "Node $version ist zu alt, gebraucht wird mindestens $MinNodeMajor (LTS)."
    }
    Write-Note "Node ${version}: $nodePath"
    return $nodePath
}

function Get-NssmPath {
    if ($Nssm) {
        if (-not (Test-Path $Nssm)) { Stop-WithError "nssm.exe nicht gefunden: $Nssm" }
        return (Resolve-Path $Nssm).Path
    }
    $found = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if (-not $found) {
        Stop-WithError 'nssm.exe wurde nicht gefunden. Von https://nssm.cc/ holen und in den PATH legen oder -Nssm <pfad> angeben.'
    }
    return $found.Source
}

function Invoke-Nssm {
    param([string]$NssmPath, [string[]]$Arguments, [switch]$IgnoreErrors)
    $output = & $NssmPath @Arguments 2>&1
    # NSSM schreibt UTF-16, deshalb die Nullbytes entfernen.
    $text = ($output | Out-String).Replace("`0", '').Trim()
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreErrors) {
        Stop-WithError "nssm $($Arguments -join ' ') schlug fehl: $text"
    }
    return $text
}

function Invoke-Pnpm {
    param([string[]]$Arguments)
    Push-Location $Root
    try {
        & corepack pnpm @Arguments
        if ($LASTEXITCODE -ne 0) {
            Stop-WithError "pnpm $($Arguments -join ' ') schlug fehl (Exitcode $LASTEXITCODE)."
        }
    }
    finally { Pop-Location }
}

# --- Konfiguration ---------------------------------------------------------

function Read-EnvFile {
    $values = @{}
    if (-not (Test-Path $EnvFile)) { return $values }
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $name = ($line -split '=', 2)[0].Trim()
        $value = ($line -split '=', 2)[1].Trim()
        if ($name) { $values[$name] = $value }
    }
    return $values
}

function New-Secret {
    # 32 Byte Zufall als Hex; landet nur in .env, nie in der Ausgabe.
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Initialize-EnvFile {
    if (-not (Test-Path $EnvFile)) {
        if (-not (Test-Path $EnvExample)) { Stop-WithError '.env.example fehlt – ist das Verzeichnis vollständig?' }
        Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
        Write-Ok '.env aus .env.example angelegt.'
    }
    else {
        Write-Note '.env ist vorhanden und wird nicht überschrieben.'
    }

    $values = Read-EnvFile
    if (-not $values.ContainsKey('HMAC_SECRET') -or -not $values['HMAC_SECRET']) {
        $secret = New-Secret
        $content = @(Get-Content -LiteralPath $EnvFile)
        $written = $false
        $content = $content | ForEach-Object {
            if ($_ -match '^\s*HMAC_SECRET\s*=' -and -not $written) {
                $written = $true
                "HMAC_SECRET=$secret"
            }
            else { $_ }
        }
        if (-not $written) { $content += "HMAC_SECRET=$secret" }
        Set-Content -LiteralPath $EnvFile -Value $content -Encoding utf8
        Write-Ok 'HMAC_SECRET erzeugt und in .env eingetragen (nach Inbetriebnahme nie ändern).'
    }
}

function Get-MissingSettings {
    $values = Read-EnvFile
    $missing = @()
    foreach ($name in @('TS3_QUERY_USER', 'TS3_QUERY_PASSWORD', 'HMAC_SECRET')) {
        if (-not $values.ContainsKey($name) -or -not $values[$name]) { $missing += $name }
    }
    # Callers wrap this in @(): PowerShell unwraps a single-element array into a plain string,
    # and `$missing.Count` on a string fails under Set-StrictMode.
    return $missing
}

function Get-WebPort {
    $values = Read-EnvFile
    if ($values.ContainsKey('WEB_PORT') -and $values['WEB_PORT']) { return [int]$values['WEB_PORT'] }
    return 8080
}

# --- Dienst ----------------------------------------------------------------

function Get-ServiceOrNull {
    return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

function Install-Service {
    param([string]$NssmPath, [string]$NodePath)
    $entry = Join-Path $Root 'dist\main.js'
    if (-not (Test-Path $entry)) { Stop-WithError "dist\main.js fehlt – wurde pnpm build ausgeführt?" }
    $outLog = Join-Path $LogDir 'service-out.log'

    if (Get-ServiceOrNull) {
        Write-Note "Dienst $ServiceName ist vorhanden, Einstellungen werden aktualisiert."
    }
    else {
        Invoke-Nssm $NssmPath @('install', $ServiceName, $NodePath, $entry) | Out-Null
        Write-Ok "Dienst $ServiceName angelegt."
    }

    # AppDirectory ist entscheidend: von dort werden .env und alle relativen Pfade gelesen.
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'Application', $NodePath) | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'AppParameters', $entry) | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'AppDirectory', $Root) | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'DisplayName', 'TS3 Analytics') | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'Description', 'TeamSpeak-Statistiken, Leaderboards und Rangsystem') | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START') | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'AppStdout', $outLog) | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'AppStderr', $outLog) | Out-Null
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'AppExit', 'Default', 'Restart') | Out-Null
    # Beim Stoppen erst freundlich fragen, damit offene Sitzungen sauber geschlossen werden.
    Invoke-Nssm $NssmPath @('set', $ServiceName, 'AppStopMethodConsole', '20000') | Out-Null
    Write-Ok 'Diensteinstellungen gesetzt (Autostart, Neustart nach Absturz, Logdatei).'
}

function Wait-Healthy {
    param([int]$TimeoutSeconds = 40)
    $port = Get-WebPort
    $url = "http://127.0.0.1:$port/api/health"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
            $health = $response.Content | ConvertFrom-Json
            if ($health.status -eq 'ok') {
                Write-Ok "Dienst antwortet auf $url (Status ok, TeamSpeak verbunden)."
            }
            else {
                Write-Warn "Dienst antwortet auf $url (Status $($health.status)) – TeamSpeak-Verbindung prüfen."
            }
            return $true
        }
        catch {
            Start-Sleep -Seconds 2
        }
    }
    Write-Warn "Keine Antwort auf $url. Logdateien unter data\logs prüfen."
    return $false
}

function Start-AppService {
    $service = Get-ServiceOrNull
    if (-not $service) { Stop-WithError "Dienst $ServiceName ist nicht installiert (erst: install)." }
    if ($service.Status -eq 'Running') {
        Write-Note 'Dienst läuft bereits.'
    }
    else {
        Start-Service -Name $ServiceName
        Write-Ok 'Dienst gestartet.'
    }
    Wait-Healthy | Out-Null
}

function Stop-AppService {
    param([switch]$Quiet)
    $service = Get-ServiceOrNull
    if (-not $service) {
        if (-not $Quiet) { Write-Note "Dienst $ServiceName ist nicht installiert." }
        return
    }
    if ($service.Status -eq 'Stopped') {
        if (-not $Quiet) { Write-Note 'Dienst läuft nicht.' }
        return
    }
    Stop-Service -Name $ServiceName
    (Get-ServiceOrNull).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    Write-Ok 'Dienst angehalten.'
}

# --- Befehle ---------------------------------------------------------------

function Invoke-Install {
    Assert-Admin 'install'
    $nssmPath = Get-NssmPath
    $nodePath = Get-NodePath

    Write-Step 'Corepack aktivieren'
    & corepack enable
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'corepack enable schlug fehl.' }

    Write-Step 'Abhängigkeiten installieren'
    Invoke-Pnpm @('install', '--frozen-lockfile')

    Write-Step 'Konfiguration vorbereiten'
    Initialize-EnvFile
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    Write-Step 'Anwendung bauen'
    Invoke-Pnpm @('build')

    Write-Step 'Dienst einrichten'
    Install-Service -NssmPath $nssmPath -NodePath $nodePath

    $missing = @(Get-MissingSettings)
    if ($missing.Count -gt 0) {
        Write-Host ''
        Write-Warn "In .env fehlen noch Werte: $($missing -join ', ')"
        Write-Note 'Datei ausfüllen, dann starten mit: .\scripts\setup.ps1 start'
    }
    else {
        Write-Step 'Dienst starten'
        Start-AppService
    }

    Write-Host ''
    Write-Note 'Erstes Admin-Konto anlegen: corepack pnpm admin:user create <name>'
    Write-Note "Weboberfläche danach unter http://127.0.0.1:$(Get-WebPort)/ (nur lokal erreichbar)."
}

function Invoke-Update {
    Assert-Admin 'update'
    Get-NodePath | Out-Null

    Write-Step 'Dienst anhalten'
    Stop-AppService

    if (-not $SkipBackup) {
        Write-Step 'Sicherung anlegen'
        Invoke-Pnpm @('backup')
    }
    else {
        Write-Warn 'Sicherung übersprungen (-SkipBackup).'
    }

    if (Test-Path (Join-Path $Root '.git')) {
        Write-Step 'Neue Version holen'
        Push-Location $Root
        try {
            & git pull --ff-only
            if ($LASTEXITCODE -ne 0) { Stop-WithError 'git pull schlug fehl – bitte von Hand prüfen.' }
        }
        finally { Pop-Location }
    }
    else {
        Write-Note 'Kein Git-Verzeichnis – neue Dateien müssen von Hand eingespielt werden.'
    }

    Write-Step 'Abhängigkeiten installieren'
    Invoke-Pnpm @('install', '--frozen-lockfile')

    Write-Step 'Anwendung bauen'
    Invoke-Pnpm @('build')

    Write-Step 'Dienst starten'
    Start-AppService
    Write-Note 'Migrationen laufen beim Start automatisch. Danach Seite „Bot-Status“ prüfen.'
}

function Invoke-Uninstall {
    Assert-Admin 'uninstall'
    $nssmPath = Get-NssmPath

    if (-not (Confirm-Action "Dienst $ServiceName entfernen?")) {
        Write-Note 'Abgebrochen.'
        return
    }

    Write-Step 'Dienst anhalten'
    Stop-AppService -Quiet

    if (Get-ServiceOrNull) {
        Write-Step 'Dienst entfernen'
        Invoke-Nssm $nssmPath @('remove', $ServiceName, 'confirm') | Out-Null
        Write-Ok "Dienst $ServiceName entfernt."
    }
    else {
        Write-Note "Dienst $ServiceName war nicht installiert."
    }

    $dataDir = Join-Path $Root 'data'
    if ($PurgeData) {
        Write-Warn 'Mit -PurgeData werden Datenbank, Logs und Sicherungen unwiderruflich gelöscht.'
        if (Confirm-Action "Wirklich $dataDir löschen?") {
            Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Ok 'Datenverzeichnis gelöscht.'
        }
        else {
            Write-Note 'Daten bleiben erhalten.'
        }
    }
    else {
        Write-Note "Daten bleiben erhalten: $dataDir (löschen mit -PurgeData)."
        Write-Note '.env bleibt ebenfalls liegen – sie enthält das HMAC-Secret.'
    }
}

function Invoke-Status {
    $service = Get-ServiceOrNull
    if ($service) {
        Write-Host "Dienst ${ServiceName}: $($service.Status)"
    }
    else {
        Write-Host "Dienst ${ServiceName}: nicht installiert"
    }

    $missing = @(Get-MissingSettings)
    if (-not (Test-Path $EnvFile)) {
        Write-Warn '.env fehlt noch.'
    }
    elseif ($missing.Count -gt 0) {
        Write-Warn "In .env fehlen Werte: $($missing -join ', ')"
    }
    else {
        Write-Note '.env ist vollständig.'
    }

    $dbPath = Join-Path $Root 'data\ts3.sqlite'
    $values = Read-EnvFile
    if ($values.ContainsKey('SQLITE_PATH') -and $values['SQLITE_PATH']) {
        $dbPath = Join-Path $Root $values['SQLITE_PATH']
    }
    if (Test-Path $dbPath) {
        $sizeMb = [math]::Round((Get-Item $dbPath).Length / 1MB, 1)
        Write-Note "Datenbank: $dbPath ($sizeMb MB)"
    }
    else {
        Write-Note "Datenbank: noch nicht angelegt ($dbPath)"
    }

    if ($service -and $service.Status -eq 'Running') {
        $port = Get-WebPort
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 5
            $health = $response.Content | ConvertFrom-Json
            Write-Note "Health: $($health.status), TeamSpeak: $($health.ts3.state), Laufzeit: $([int]$health.uptimeS) s"
        }
        catch {
            Write-Warn "Keine Antwort auf http://127.0.0.1:$port/api/health"
        }
    }
}

switch ($Command) {
    'install' { Invoke-Install }
    'update' { Invoke-Update }
    'start' { Start-AppService }
    'stop' { Stop-AppService }
    'uninstall' { Invoke-Uninstall }
    'status' { Invoke-Status }
}
