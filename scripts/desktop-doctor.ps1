$ErrorActionPreference = 'Stop'

$required = @('git', 'cmake', 'cargo', 'rustc')
$missing = @($required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
$msvc = Test-Path 'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$sdkRoot = if ($env:VALE_VST3_SDK_ROOT) { $env:VALE_VST3_SDK_ROOT } else { Join-Path (Resolve-Path "$PSScriptRoot\..") 'work\vst3sdk' }

Write-Output "Vale Studio Desktop doctor"
Write-Output "VST3 SDK: $sdkRoot"
foreach ($tool in $required) {
  $command = Get-Command $tool -ErrorAction SilentlyContinue
  Write-Output ("{0}: {1}" -f $tool, $(if ($command) { $command.Source } else { 'ausente' }))
}
Write-Output ("MSVC Build Tools 2022: {0}" -f $(if ($msvc) { 'encontrado' } else { 'ausente' }))

if ($missing.Count -gt 0 -or -not $msvc) {
  Write-Error 'Para criar o .exe são necessários Rust, CMake e Visual Studio Build Tools (C++). Consulte docs/DESKTOP-WINDOWS.md.'
}
