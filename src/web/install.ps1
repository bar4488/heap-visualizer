$ErrorActionPreference = "Stop"
$base = $env:HEAPVIZ_DOWNLOAD_BASE
if (-not $base) { throw "HEAPVIZ_DOWNLOAD_BASE is required; use the install command shown by your hosted heap visualizer" }
$base = $base.TrimEnd("/")
$dir = if ($env:HEAPVIZ_BIN_DIR) { $env:HEAPVIZ_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\heapviz" }
$configDir = Join-Path $env:LOCALAPPDATA "heapviz"
$exe = Join-Path $dir "heapviz.exe"
$download = "$exe.download"
$checksum = "$exe.sha256"
New-Item -ItemType Directory -Force -Path $dir, $configDir | Out-Null

try {
  Invoke-WebRequest "$base/downloads/heapviz-windows-x86_64.exe" -OutFile $download
  Invoke-WebRequest "$base/downloads/heapviz-windows-x86_64.exe.sha256" -OutFile $checksum
  $expected = (Get-Content -Raw $checksum).Trim().ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "heapviz download checksum did not match" }
  Move-Item -Force $download $exe
  Set-Content -NoNewline -Path (Join-Path $configDir "channel-url") -Value "$base/downloads/heapviz-channel.json"
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $download, $checksum
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $dir)) {
  $next = if ($userPath) { "$userPath;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
}
if (-not (($env:Path -split ";") -contains $dir)) { $env:Path = "$env:Path;$dir" }
Write-Host "Installed heapviz at $exe"
Write-Host "Updates will come from $base"
Write-Host "Next: heapviz doctor"
