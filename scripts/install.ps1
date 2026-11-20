& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $assetName = 'momonga-win-x64.exe'
  $checksumsName = 'SHA256SUMS'
  $signatureName = 'SHA256SUMS.sig'
  $signatureNamespace = 'momonga-release'
  $embeddedReleasePublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEsNopRVJ6s7vlMTDNEr6C/4bOBn2UyAFvMFQKu+TVyd'
  $embeddedReleaseRepo = 'yuuichieguchi/MomongaCode'

  function Fail([string]$message) {
    throw "install.ps1: $message"
  }

  function Read-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
  function Write-UserPath([string]$value) { [Environment]::SetEnvironmentVariable('Path', $value, 'User') }

  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail "unsupported architecture ${env:PROCESSOR_ARCHITECTURE}: only x64 is supported" }

  if ($env:MOMONGA_INSTALL_PREFIX) { $prefix = $env:MOMONGA_INSTALL_PREFIX } else { $prefix = Join-Path $env:LOCALAPPDATA 'Programs\momonga' }

  if ($env:MOMONGA_RELEASE_BASE_URL) {
    $baseUrl = $env:MOMONGA_RELEASE_BASE_URL
  } else {
    if ($env:MOMONGA_REPO) { $repo = $env:MOMONGA_REPO } else { $repo = $embeddedReleaseRepo }
    if (-not $repo) { Fail 'set MOMONGA_REPO=<owner>/<repo> or MOMONGA_RELEASE_BASE_URL' }
    if ($env:MOMONGA_VERSION) { $baseUrl = "https://github.com/$repo/releases/download/v$($env:MOMONGA_VERSION)" }
    else { $baseUrl = "https://github.com/$repo/releases/latest/download" }
  }

  if ($env:MOMONGA_RELEASE_PUBLIC_KEY) { $publicKey = $env:MOMONGA_RELEASE_PUBLIC_KEY } else { $publicKey = $embeddedReleasePublicKey }
  if (-not $publicKey) { Fail 'this installer pins no release signing key, so it cannot verify the release: install from a release whose installer pins the key, or set MOMONGA_RELEASE_PUBLIC_KEY to the ssh public key line the maintainers publish (ssh-ed25519 AAAA...)' }
  if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$') { Fail 'the release signing key is not one ssh-ed25519 public key line (ssh-ed25519 AAAA...), so it cannot verify the release; nothing was installed' }
  $sshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue
  if (-not $sshKeygen) { Fail 'ssh-keygen is required to verify the release signature: enable the Windows OpenSSH Client optional feature' }
  if ($baseUrl -notmatch '^https://' -and $baseUrl -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(/|$)') {
    Fail "the release location must be https (plain http is accepted only on the loopback interface), got $baseUrl"
  }

  New-Item -ItemType Directory -Force -Path $prefix | Out-Null
  $staging = Join-Path $prefix ('.momonga-install.' + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$checksumsName" -OutFile (Join-Path $staging $checksumsName)
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$signatureName" -OutFile (Join-Path $staging $signatureName)
    $allowedSigners = Join-Path $staging 'allowed_signers'
    Set-Content -LiteralPath $allowedSigners -Value "$signatureNamespace $publicKey" -Encoding ascii
    $verification = Start-Process -FilePath $sshKeygen.Source -ArgumentList @('-Y', 'verify', '-f', "`"$allowedSigners`"", '-I', $signatureNamespace, '-n', $signatureNamespace, '-s', "`"$(Join-Path $staging $signatureName)`"") -RedirectStandardInput (Join-Path $staging $checksumsName) -RedirectStandardOutput (Join-Path $staging 'verify.out') -RedirectStandardError (Join-Path $staging 'verify.err') -NoNewWindow -Wait -PassThru
    if ($verification.ExitCode -ne 0) { Fail "$checksumsName is not signed by the pinned release key; nothing was installed" }
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$assetName" -OutFile (Join-Path $staging $assetName)

    $expected = $null
    foreach ($line in Get-Content (Join-Path $staging $checksumsName)) {
      $fields = $line -split '\s+'
      if ($fields.Count -ge 2 -and ($fields[1] -replace '^\*', '') -eq $assetName) { $expected = $fields[0].ToLowerInvariant() }
    }
    if (-not $expected -or $expected -notmatch '^[0-9a-f]{64}$') { Fail "$checksumsName has no valid entry for $assetName" }

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $staging $assetName)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "the downloaded $assetName does not match the SHA-256 that $checksumsName records (expected $expected, got $actual); nothing was installed" }

    $candidate = Join-Path $staging $assetName
    $reported = & $candidate --version
    if ($LASTEXITCODE -ne 0) { Fail "the downloaded executable exited with code $LASTEXITCODE for --version; nothing was installed" }
    $reported = "$reported".Trim()
    if ($env:MOMONGA_VERSION -and $reported -ne $env:MOMONGA_VERSION) { Fail "version $($env:MOMONGA_VERSION) was asked for, but the downloaded executable reports version $reported; nothing was installed" }

    $target = Join-Path $prefix 'momonga.exe'
    $aside = $null
    if (Test-Path -LiteralPath $target) {
      $aside = Join-Path $prefix ('.momonga-update.' + [System.Guid]::NewGuid().ToString('N'))
      try {
        Move-Item -LiteralPath $target -Destination $aside
      } catch {
        Fail "$target is in use and could not be moved aside ($($_.Exception.Message)): stop the daemon, then run the command again"
      }
      New-Item -ItemType File -Path ($aside + '.sqlite') | Out-Null
    }
    try {
      Move-Item -LiteralPath $candidate -Destination $target
    } catch {
      if ($aside) { Move-Item -LiteralPath $aside -Destination $target }
      throw
    }
    Write-Output "installed momonga to $target"

    $openShellLine = @"
`$env:Path = "$prefix;`$env:Path"
"@
    $normalize = { param([string]$entry) $entry.Trim().TrimEnd('\', '/').ToLowerInvariant() }
    $userPath = [string](Read-UserPath)
    $entries = @($userPath -split ';' | Where-Object { $_ })
    $onUserPath = @($entries | Where-Object { (& $normalize $_) -eq (& $normalize $prefix) }).Count -gt 0
    if (-not $onUserPath) {
      if ($env:MOMONGA_MODIFY_PATH -ne '0') {
        Write-UserPath ((@($entries) + $prefix) -join ';')
        Write-Output "added $prefix to the user PATH"
      } else {
        Write-Output "$prefix is not on your user PATH"
      }
      Write-Output 'To use momonga in this PowerShell session now, run:'
      Write-Output ''
      Write-Output "  $openShellLine"
    }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $staging
  }
}
