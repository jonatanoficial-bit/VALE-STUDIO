param(
  [string]$SdkRoot
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..").Path
if (-not $SdkRoot) {
  $SdkRoot = if ($env:VALE_VST3_SDK_ROOT) { $env:VALE_VST3_SDK_ROOT } else { Join-Path $root 'work\vst3sdk' }
}

foreach ($tool in @('git', 'cmake', 'cargo')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Ferramenta ausente: $tool. Execute pnpm desktop:doctor e siga docs/DESKTOP-WINDOWS.md."
  }
}

if (-not (Test-Path (Join-Path $SdkRoot 'CMakeLists.txt'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $SdkRoot -Parent) | Out-Null
  Write-Output 'Baixando o VST3 SDK oficial com submódulos...'
  git clone --recursive https://github.com/steinbergmedia/vst3sdk.git $SdkRoot
}

$hostSource = Join-Path $root 'native\vst3-host'
$hostBuild = Join-Path $root 'work\vst3-host-build'
Write-Output 'Compilando o host VST3 isolado (Windows x64)...'
cmake -S $hostSource -B $hostBuild -G 'Visual Studio 17 2022' -A x64 "-DVST3_SDK_ROOT=$SdkRoot"
cmake --build $hostBuild --config Release --target vst3-host

$host = Join-Path $hostSource 'dist\vst3-host.exe'
if (-not (Test-Path $host)) {
  throw "A compilação terminou sem gerar $host."
}
Write-Output "Host VST3 pronto: $host"
