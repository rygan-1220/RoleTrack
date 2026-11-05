$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$zipPath = Join-Path $root 'RoleTrack.zip'
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$items = @('manifest.json', 'background.js', 'content.js', 'content.css', 'content', 'icons', 'services', 'sidepanel', 'utils')

try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    foreach ($item in $items) {
        Copy-Item -LiteralPath (Join-Path $root $item) -Destination $tempDir -Recurse
    }
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $tempDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
    Write-Host "Created $zipPath"
}
finally {
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
