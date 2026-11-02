$ErrorActionPreference = 'Stop'

$assetName = 'momonga-win-x64.exe'
$checksumsName = 'SHA256SUMS'

function Fail([string]$message) {
  throw "install.ps1: $message"
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail "unsupported architecture $env:PROCESSOR_ARCHITECTURE: only x64 is supported" }

if ($env:MOMONGA_INSTALL_PREFIX) { $prefix = $env:MOMONGA_INSTALL_PREFIX } else { $prefix = Join-Path $env:LOCALAPPDATA 'Programs\momonga' }

if ($env:MOMONGA_RELEASE_BASE_URL) {
  $baseUrl = $env:MOMONGA_RELEASE_BASE_URL
} else {
  if (-not $env:MOMONGA_REPO) { Fail 'set MOMONGA_REPO=<owner>/<repo> or MOMONGA_RELEASE_BASE_URL' }
  if ($env:MOMONGA_VERSION) { $baseUrl = "https://github.com/$($env:MOMONGA_REPO)/releases/download/v$($env:MOMONGA_VERSION)" }
  else { $baseUrl = "https://github.com/$($env:MOMONGA_REPO)/releases/latest/download" }
}

New-Item -ItemType Directory -Force -Path $prefix | Out-Null
$staging = Join-Path $prefix ('.momonga-install.' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$checksumsName" -OutFile (Join-Path $staging $checksumsName)
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$assetName" -OutFile (Join-Path $staging $assetName)

  $expected = $null
  foreach ($line in Get-Content (Join-Path $staging $checksumsName)) {
    $fields = $line -split '\s+'
    if ($fields.Count -ge 2 -and $fields[1].TrimStart('*') -eq $assetName) { $expected = $fields[0].ToLowerInvariant() }
  }
  if (-not $expected -or $expected -notmatch '^[0-9a-f]{64}$') { Fail "$checksumsName has no valid entry for $assetName" }

  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $staging $assetName)).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail "sha256 mismatch for ${assetName}: expected $expected, got $actual; nothing was installed" }

  $target = Join-Path $prefix 'momonga.exe'
  Move-Item -Force -LiteralPath (Join-Path $staging $assetName) -Destination $target
  Write-Output "installed momonga to $target"
} finally {
  Remove-Item -Recurse -Force -LiteralPath $staging
}
