param(
    [ValidateSet('amd64', 'arm64')]
    [string]$Architecture = 'amd64',
    [ValidatePattern('^[A-Za-z0-9._+-]+$')]
    [string]$Version = 'dev'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw '请先在编译电脑安装 Go，再重新打开脚本；部署服务器不需要安装 Go。'
}
$folderName = "ydesk-server-linux-$Architecture"
$outputRoot = Join-Path $projectRoot 'dist\server'
$packageDirectory = Join-Path $outputRoot $folderName
New-Item -ItemType Directory -Force -Path $packageDirectory | Out-Null
$savedEnvironment = @{}
foreach ($name in @('GOOS', 'GOARCH', 'CGO_ENABLED')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location (Join-Path $projectRoot 'server-go')
try {
    # Windows 上直接交叉编译 Linux 程序，无需 Docker 或 Linux 虚拟机。
    $env:GOOS = 'linux'
    $env:GOARCH = $Architecture
    $env:CGO_ENABLED = '0'
    & go build -trimpath -ldflags "-s -w -X main.version=$Version" -o (Join-Path $packageDirectory 'ydesk-server') .
    if ($LASTEXITCODE -ne 0) { throw 'Go 编译失败，未更新 ZIP 包。' }
}
finally {
    Pop-Location
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

$textFiles = @{
    'install.sh' = 'deploy/install-go.sh'
    'ydesk-signaling.service' = 'deploy/ydesk-signaling.service'
    'nginx-ydesk.conf' = 'deploy/nginx-ydesk.conf'
    'turnserver.conf.example' = 'deploy/turnserver.conf.example'
    'README.md' = 'docs/go-server.md'
}
foreach ($name in $textFiles.Keys) {
    # Windows 检出可能使用 CRLF；Linux 脚本和配置统一使用无 BOM 的 UTF-8、LF。
    $content = [IO.File]::ReadAllText((Join-Path $projectRoot $textFiles[$name])).Replace("`r`n", "`n")
    [IO.File]::WriteAllText((Join-Path $packageDirectory $name), $content, (New-Object Text.UTF8Encoding($false)))
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zipPath = Join-Path $outputRoot "$folderName.zip"
$temporaryZip = Join-Path $outputRoot "$folderName.$([Guid]::NewGuid().ToString('N')).zip"
try {
    $archive = [IO.Compression.ZipFile]::Open($temporaryZip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        # 仅打包已知发布文件，避免目录里的其他文件被带入安装包。
        foreach ($name in (@('ydesk-server') + @($textFiles.Keys))) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $packageDirectory $name), "$folderName/$name", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally { $archive.Dispose() }
    Move-Item -LiteralPath $temporaryZip -Destination $zipPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip }
}
Write-Host "已生成：$zipPath"
Write-Host '上传 Linux 解压后，执行 chmod +x ydesk-server，再执行 bash install.sh。'
