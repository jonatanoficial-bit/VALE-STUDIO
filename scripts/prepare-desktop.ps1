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
$cmakeHelp = (& cmake --help 2>&1 | Out-String)
$generator = @('Visual Studio 18 2026', 'Visual Studio 17 2022') |
  Where-Object { $cmakeHelp.Contains($_) } |
  Select-Object -First 1

if (-not $generator) {
  throw 'Nenhum gerador Visual Studio compatível foi encontrado pelo CMake. Instale o Visual Studio Build Tools com Desktop development with C++ e use CMake 3.25 ou superior.'
}

Write-Output 'Compilando o host VST3 isolado (Windows x64)...'
Write-Output "Gerador CMake: $generator"
cmake -S $hostSource -B $hostBuild -G $generator -A x64 "-DVST3_SDK_ROOT=$SdkRoot"
if ($LASTEXITCODE -ne 0) {
  throw 'O CMake não conseguiu configurar o host VST3.'
}

cmake --build $hostBuild --config Release --target vst3-host
if ($LASTEXITCODE -ne 0) {
  throw 'O CMake não conseguiu compilar o host VST3.'
}

$hostBinary = Join-Path $hostSource 'dist\vst3-host.exe'
if (-not (Test-Path $hostBinary)) {
  throw "A compilação terminou sem gerar $hostBinary."
}
Write-Output "Host VST3 pronto: $hostBinary"
