# Generates the SN Assignflow icon set into chrome\icons\ (then sync to firefox\).
#
# The mark is a distribution fork: one stem entering from the left, splitting
# into two arrowheads on the right — round-robin, drawn literally.
#
# Everything is rendered at 8x and downsampled with high-quality bicubic, which
# is what keeps the 16px version from turning to mush. Below 32px the fork is
# dropped for a single arrow, because two arrowheads inside 16 pixels is noise
# rather than a glyph.
#
#   powershell -ExecutionPolicy Bypass -File .\tools\make-icons.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root    = Split-Path -Parent $PSScriptRoot
$outDir  = Join-Path $root 'chrome\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$brand = [System.Drawing.Color]::FromArgb(255, 124, 58, 237)   # #7C3AED
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x,           $y,           $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y,           $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d,   0, 90)
    $p.AddArc($x,           $y + $h - $d, $d, $d,  90, 90)
    $p.CloseFigure()
    return $p
}

# Draws the glyph into a unit box of size $s (already scaled up).
function Draw-Glyph([System.Drawing.Graphics]$g, [float]$s, [bool]$simple) {
    $pen = New-Object System.Drawing.Pen($white, ($s * 0.105))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $brush = New-Object System.Drawing.SolidBrush($white)

    if ($simple) {
        # 16px: one bold arrow, centred.
        $y = $s * 0.5
        $g.DrawLine($pen, ($s * 0.24), $y, ($s * 0.60), $y)
        $head = New-Object 'System.Drawing.PointF[]' 3
        $head[0] = New-Object System.Drawing.PointF(($s * 0.56), ($s * 0.28))
        $head[1] = New-Object System.Drawing.PointF(($s * 0.82), $y)
        $head[2] = New-Object System.Drawing.PointF(($s * 0.56), ($s * 0.72))
        $g.FillPolygon($brush, $head)
    }
    else {
        # Node on the left, a short stem, then a symmetric fork to two
        # arrowheads. Each arrowhead is built from the arm's own direction
        # vector so the triangle sits square on the end of its arm.
        $cy = $s * 0.5
        $nodeX = $s * 0.287
        $nr    = $s * 0.072
        $forkX = $s * 0.502

        $armLen  = $s * 0.25
        $headLen = $s * 0.13
        $headHalf = $s * 0.085
        $ang = 42.0 * [Math]::PI / 180.0
        $ca  = [Math]::Cos($ang)
        $sa  = [Math]::Sin($ang)

        $g.FillEllipse($brush, ($nodeX - $nr), ($cy - $nr), ($nr * 2), ($nr * 2))
        $g.DrawLine($pen, ($nodeX + $nr * 1.1), $cy, $forkX, $cy)

        foreach ($dir in @(-1, 1)) {
            # Arm: from the fork point outwards at +/- the fork angle.
            $ex = $forkX + $armLen * $ca
            $ey = $cy + $dir * $armLen * $sa
            $g.DrawLine($pen, $forkX, $cy, $ex, $ey)

            # Arrowhead: tip further along the same unit vector, base corners
            # offset perpendicular to it.
            $ux = $ca
            $uy = $dir * $sa
            $tipX = $ex + $headLen * $ux
            $tipY = $ey + $headLen * $uy
            $px   = -$uy * $headHalf
            $py   =  $ux * $headHalf

            $tri = New-Object 'System.Drawing.PointF[]' 3
            $tri[0] = New-Object System.Drawing.PointF($tipX, $tipY)
            $tri[1] = New-Object System.Drawing.PointF(($ex + $px), ($ey + $py))
            $tri[2] = New-Object System.Drawing.PointF(($ex - $px), ($ey - $py))
            $g.FillPolygon($brush, $tri)
        }
    }

    $pen.Dispose()
    $brush.Dispose()
}

function New-Icon([int]$size) {
    $scale = 8
    $big   = $size * $scale

    $bmp = New-Object System.Drawing.Bitmap($big, $big, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded-square plate. Corner radius tracks iOS-ish 22% of the side.
    $radius = $big * 0.22
    $plate  = New-RoundedPath 0 0 $big $big $radius
    $fill   = New-Object System.Drawing.SolidBrush($brand)
    $g.FillPath($fill, $plate)
    $fill.Dispose()
    $plate.Dispose()

    Draw-Glyph $g $big ($size -lt 32)
    $g.Dispose()

    # Downsample to the target size.
    $out  = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $og   = [System.Drawing.Graphics]::FromImage($out)
    $og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $og.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $og.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $og.Clear([System.Drawing.Color]::Transparent)
    $og.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    $og.Dispose()
    $bmp.Dispose()

    $path = Join-Path $outDir ("icon{0}.png" -f $size)
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()

    $kb = [Math]::Round((Get-Item $path).Length / 1KB, 1)
    Write-Host ("  icon{0}.png  {1} KB" -f $size, $kb)
}

Write-Host "Rendering SN Assignflow icons (#7C3AED):"
foreach ($s in @(16, 48, 128)) { New-Icon $s }
Write-Host ""
Write-Host ("Written to {0}" -f $outDir)
Write-Host "Run tools\sync-firefox.ps1 to copy them into firefox\icons\."
