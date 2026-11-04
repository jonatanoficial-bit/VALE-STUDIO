$ErrorActionPreference = 'Stop'

$required = @('git', 'cmake', 'cargo', 'rustc')
$missing = @($required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvcPath = if (Test-Path $vswhere) {
  (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1).Trim()
} else {
  ''
}
$msvc = -not [string]::IsNullOrWhiteSpace($msvcPath)
$sdkRoot = if ($env:VALE_VST3_SDK_ROOT) { $env:VALE_VST3_SDK_ROOT } else { Join-Path (Resolve-Path "$PSScriptRoot\..") 'work\vst3sdk' }

Write-Output "Vale Studio Desktop doctor"
Write-Output "VST3 SDK: $sdkRoot"
foreach ($tool in $required) {
  $command = Get-Command $tool -ErrorAction SilentlyContinue
  Write-Output ("{0}: {1}" -f $tool, $(if ($command) { $command.Source } else { 'ausente' }))
}
Write-Output ("MSVC Build Tools (C++): {0}" -f $(if ($msvc) { "encontrado em $msvcPath" } else { 'ausente' }))

if ($missing.Count -gt 0 -or -not $msvc) {
  Write-Error 'Para criar o .exe são necessários Rust, CMake e Visual Studio Build Tools (C++). Consulte docs/DESKTOP-WINDOWS.md.'
}
