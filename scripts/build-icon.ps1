$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'
New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$outline = [System.Drawing.Drawing2D.GraphicsPath]::new()
$outline.AddArc(8, 8, 64, 64, 180, 90)
$outline.AddArc(184, 8, 64, 64, 270, 90)
$outline.AddArc(184, 184, 64, 64, 0, 90)
$outline.AddArc(8, 184, 64, 64, 90, 90)
$outline.CloseFigure()
$blue = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(30, 97, 212))
$graphics.FillPath($blue, $outline)
$points = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(58, 59), [System.Drawing.PointF]::new(91, 59),
    [System.Drawing.PointF]::new(128, 114), [System.Drawing.PointF]::new(165, 59),
    [System.Drawing.PointF]::new(198, 59), [System.Drawing.PointF]::new(144, 140),
    [System.Drawing.PointF]::new(144, 201), [System.Drawing.PointF]::new(112, 201),
    [System.Drawing.PointF]::new(112, 140)
)
$graphics.FillPolygon([System.Drawing.Brushes]::White, $points)
$png = [System.IO.MemoryStream]::new()
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $png.ToArray()
# ICO 内使用 PNG 数据，宽高 0 表示 256 像素。
$file = [System.IO.File]::Create((Join-Path $assetDirectory 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22); $writer.Write($bytes)
$writer.Dispose(); $file.Dispose(); $png.Dispose()
$blue.Dispose(); $outline.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
Write-Output 'Generated assets/icon.ico'
