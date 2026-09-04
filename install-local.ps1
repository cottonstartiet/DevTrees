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
$tauriCli = Join-Path $repoRoot 'node_modules\@tauri-apps\cli\tauri.js'
$yarn = Get-Command 'yarn.cmd' -ErrorAction SilentlyContinue
$cargo = Get-Command 'cargo.exe' -ErrorAction SilentlyContinue

if (-not $yarn) {
  throw 'Yarn was not found. Install Yarn 1.x, then run this script again.'
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
  & $yarn.Source tauri build --bundles nsis --config $localConfigPath

  if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
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
