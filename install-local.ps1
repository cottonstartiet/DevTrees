[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'The NSIS installer can only be built and launched on Windows.'
}

$repoRoot = $PSScriptRoot
$tauriConfig = Join-Path $repoRoot 'src-tauri\tauri.conf.json'
$bundleDirectory = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
$cargoManifest = Join-Path $repoRoot 'src-tauri\Cargo.toml'
$cliCacheDirectory = Join-Path $repoRoot 'src-tauri\target\copilot-cli-cache'
$tauriCli = Join-Path $repoRoot 'node_modules\@tauri-apps\cli\tauri.js'
$yarn = Get-Command 'yarn.cmd' -ErrorAction SilentlyContinue
$npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
$cargo = Get-Command 'cargo.exe' -ErrorAction SilentlyContinue

if (-not $yarn) {
  throw 'Yarn was not found. Install Yarn 1.x, then run this script again.'
}

if (-not $npm) {
  throw 'npm was not found. Install Node.js, then run this script again.'
}

if (-not $cargo) {
  throw 'Cargo was not found. Install the Rust toolchain, then run this script again.'
}

if (-not (Test-Path -LiteralPath $tauriConfig -PathType Leaf)) {
  throw "Tauri configuration was not found at '$tauriConfig'."
}

if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
  throw "Project dependencies are missing. Run 'yarn install' first."
}

if (Test-Path -LiteralPath $bundleDirectory) {
  Remove-Item -LiteralPath $bundleDirectory -Recurse -Force
}

$metadataJson = & $cargo.Source metadata `
  --manifest-path $cargoManifest `
  --format-version 1
if ($LASTEXITCODE -ne 0) {
  throw "Cargo metadata failed with exit code $LASTEXITCODE."
}

$metadata = ($metadataJson -join [System.Environment]::NewLine) | ConvertFrom-Json
$sdkPackage = @($metadata.packages | Where-Object name -eq 'github-copilot-sdk')
if ($sdkPackage.Count -ne 1) {
  throw "Expected one github-copilot-sdk package, but found $($sdkPackage.Count)."
}

$sdkDirectory = Split-Path -Parent $sdkPackage[0].manifest_path
$cliVersionFile = Join-Path $sdkDirectory 'cli-version-in-process.txt'
if (-not (Test-Path -LiteralPath $cliVersionFile -PathType Leaf)) {
  throw "Copilot CLI version file was not found at '$cliVersionFile'."
}

$cliVersionManifest = Get-Content -LiteralPath $cliVersionFile -Raw
$cliVersionMatch = [System.Text.RegularExpressions.Regex]::Match(
  $cliVersionManifest,
  '(?m)^version=(?<version>[^\r\n]+)\r?$'
)
if (-not $cliVersionMatch.Success) {
  throw "Copilot CLI version was not found in '$cliVersionFile'."
}
$cliVersion = $cliVersionMatch.Groups['version'].Value.Trim()
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$cliPackageName = switch ($architecture) {
  'X64' { 'copilot-win32-x64' }
  'Arm64' { 'copilot-win32-arm64' }
  default { throw "Unsupported Windows architecture: $architecture." }
}

$archiveName = "$cliPackageName-$cliVersion.tgz"
$cachedArchive = Join-Path $cliCacheDirectory "v$cliVersion-$archiveName"

if (-not (Test-Path -LiteralPath $cachedArchive -PathType Leaf)) {
  $packageDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
    "devtrees-copilot-package-$([System.Guid]::NewGuid().ToString('N'))"
  )
  New-Item -ItemType Directory -Path $packageDirectory | Out-Null

  try {
    Push-Location $packageDirectory
    try {
      Write-Host "Caching @github/$cliPackageName@$cliVersion..."
      $packedArchiveName = & $npm.Source pack `
        "@github/$cliPackageName@$cliVersion" `
        --silent
      if ($LASTEXITCODE -ne 0) {
        throw "npm pack failed with exit code $LASTEXITCODE."
      }
    }
    finally {
      Pop-Location
    }

    $packedArchive = Join-Path $packageDirectory ($packedArchiveName | Select-Object -Last 1)
    if (-not (Test-Path -LiteralPath $packedArchive -PathType Leaf)) {
      throw "npm did not create the expected archive at '$packedArchive'."
    }

    New-Item -ItemType Directory -Force -Path $cliCacheDirectory | Out-Null
    Move-Item -LiteralPath $packedArchive -Destination $cachedArchive
  }
  finally {
    Remove-Item -LiteralPath $packageDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# A file avoids Yarn/shell quote handling corrupting the JSON argument.
$localConfigPath = Join-Path ([System.IO.Path]::GetTempPath()) (
  "devtrees-tauri-local-$([System.Guid]::NewGuid().ToString('N')).json"
)
Set-Content -LiteralPath $localConfigPath `
  -Value '{"bundle":{"createUpdaterArtifacts":false}}' `
  -Encoding UTF8

Push-Location $repoRoot
try {
  Write-Host 'Building local NSIS installer...'
  $env:BUNDLED_CLI_CACHE_DIR = $cliCacheDirectory
  & $yarn.Source tauri build --bundles nsis --config $localConfigPath

  if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
  Remove-Item Env:\BUNDLED_CLI_CACHE_DIR -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $localConfigPath -Force -ErrorAction SilentlyContinue
}

$installers = @(
  Get-ChildItem -LiteralPath $bundleDirectory -Filter '*-setup.exe' -File
)

if ($installers.Count -ne 1) {
  $found = if ($installers.Count -eq 0) { 'none' } else { $installers.Count }
  throw "Expected one NSIS installer in '$bundleDirectory', but found $found."
}

$installer = $installers[0]
Write-Host "Launching installer: $($installer.FullName)"
Start-Process -FilePath $installer.FullName
