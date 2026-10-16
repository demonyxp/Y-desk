$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw '需要 Windows x64 和 .NET Framework 4.8。' }
$outputDirectory = Join-Path $projectRoot 'native\bin'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
& $compilerPath /nologo /target:exe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll "/out:$outputDirectory\YDesk.Input.exe" "$projectRoot\native\Input.cs"
if ($LASTEXITCODE -ne 0) { throw '输入组件编译失败。' }
Write-Output "已生成 $outputDirectory\YDesk.Input.exe"
