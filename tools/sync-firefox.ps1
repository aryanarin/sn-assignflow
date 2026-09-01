# Copies the shared extension files from chrome\ into firefox\.
#
# Both builds run byte-identical JS, HTML, CSS and icons. Only manifest.json
# differs, so that one file is never touched here:
#
#   chrome\manifest.json   -> "background": { "service_worker": "background.js" }
#   firefox\manifest.json  -> "background": { "scripts": ["background.js"] }
#                             + browser_specific_settings (gecko id, min version)
#
# The code needs no compatibility shim. Firefox implements the `chrome.*`
# namespace under Manifest V3 and returns promises when no callback is passed,
# which is the style this codebase uses throughout.
#
# Run this after any change under chrome\, then re-run the checks:
#
#   powershell -ExecutionPolicy Bypass -File .\tools\sync-firefox.ps1
#   node tools\check-wiring.js

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'chrome'
$dst  = Join-Path $root 'firefox'

$shared = @(
  'shared.js',
  'background.js',
  'widget.js',
  'widget.css',
  'theme.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'config.html',
  'config.css',
  'config.js',
  'icons\icon16.png',
  'icons\icon48.png',
  'icons\icon128.png'
)

New-Item -ItemType Directory -Force -Path (Join-Path $dst 'icons') | Out-Null

$copied  = 0
$missing = 0

foreach ($rel in $shared) {
  $from = Join-Path $src $rel
  $to   = Join-Path $dst $rel

  if (-not (Test-Path $from)) {
    Write-Host ("MISSING  {0}" -f $rel) -ForegroundColor Yellow
    $missing++
    continue
  }

  Copy-Item -Path $from -Destination $to -Force
  Write-Host ("synced   {0}" -f $rel)
  $copied++
}

# Anything in firefox\ that isn't shared and isn't its own manifest is stale —
# usually a file renamed in chrome\ and left behind here.
$allowed = New-Object System.Collections.Generic.HashSet[string]
foreach ($rel in $shared) { [void]$allowed.Add($rel.Replace('\', '/')) }
[void]$allowed.Add('manifest.json')

$stale = @()
Get-ChildItem -Path $dst -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($dst.Length + 1).Replace('\', '/')
  if (-not $allowed.Contains($rel)) { $stale += $rel }
}

Write-Host ""
Write-Host ("{0} file(s) synced. manifest.json left alone." -f $copied)
if ($missing) { Write-Host ("{0} expected file(s) missing from chrome\." -f $missing) -ForegroundColor Yellow }
if ($stale.Count) {
  Write-Host ""
  Write-Host "Stale files in firefox\ (not part of the shared set):" -ForegroundColor Yellow
  $stale | ForEach-Object { Write-Host ("  {0}" -f $_) -ForegroundColor Yellow }
}
