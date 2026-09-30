# Installs the Windows desktop installer silently, launches the app on a test repository, and checks that the window
# and its background server come up. Also saves a screenshot. Run on a Windows machine:
#   pwsh scripts/smoke-desktop-windows.ps1 -Installer path\to\Braid_x.y.z_x64-setup.exe
param([Parameter(Mandatory = $true)][string]$Installer, [string]$Screenshot = 'desktop-windows.png')
$ErrorActionPreference = 'Stop'
$failed = 0
function Check($ok, $what, $detail = '') {
  if ($ok) { Write-Host "ok   $what" } else { Write-Host "FAIL $what  $detail"; $script:failed++ }
}

Write-Host "installing $Installer"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
Check ($p.ExitCode -eq 0) 'the installer runs silently and exits cleanly' "exit code $($p.ExitCode)"

$dir = Join-Path $env:LOCALAPPDATA 'Braid'
if (-not (Test-Path $dir)) { $dir = (Get-ChildItem -Path $env:LOCALAPPDATA, $env:ProgramFiles -Recurse -Filter 'braid-desktop.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).DirectoryName }
Write-Host "install folder: $dir"
Get-ChildItem $dir -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table | Out-String | Write-Host
$app = Join-Path $dir 'braid-desktop.exe'
Check (Test-Path $app) 'the app is installed' $app
Check (Test-Path (Join-Path $dir 'braid.exe')) 'the bundled braid program sits next to it' $dir

# a throwaway repository to open
$repo = Join-Path $env:RUNNER_TEMP 'smoke-repo'
if (-not $env:RUNNER_TEMP) { $repo = Join-Path ([System.IO.Path]::GetTempPath()) 'smoke-repo' }
New-Item -ItemType Directory -Force $repo | Out-Null
Push-Location $repo
git init -q -b main
'hello' | Set-Content README.md
git add -A
git -c user.name=smoke -c user.email=smoke@localhost commit -q -m init
Pop-Location

Write-Host "launching the app on $repo"
$proc = Start-Process -FilePath $app -ArgumentList '--repo', $repo -PassThru
$port = $null
for ($i = 0; $i -lt 60 -and -not $port; $i++) {
  Start-Sleep -Seconds 1
  $side = Get-Process -Name braid -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($side) {
    $conn = Get-NetTCPConnection -State Listen -OwningProcess $side.Id -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
    if ($conn) { $port = $conn.LocalPort }
  }
}
Check ($null -ne $port) 'the app starts its background server for the repository' 'no braid.exe listening on loopback after 60 s'
if ($port) {
  $cfg = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/config").Content
  Check ($cfg -match '"control":true') 'the server has run controls switched on' $cfg
  $page = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/")
  Check ($page.StatusCode -eq 200 -and $page.Content.Length -gt 20000) 'the dashboard page is served' "$($page.Content.Length) bytes"
}

Start-Sleep -Seconds 6
$win = Get-Process -Name braid-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
Check ($null -ne $win) 'the app shows a window' 'no process with a main window'
if ($win) { Write-Host "window title: $($win.MainWindowTitle)"; Check ($win.MainWindowTitle -like 'braid - *') 'the window is titled with the repository name' $win.MainWindowTitle }

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($Screenshot)
  Write-Host "screenshot saved: $Screenshot ($($b.Width)x$($b.Height))"
} catch { Write-Host "no screenshot: $_" }

Get-Process -Name braid-desktop, braid -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Check (-not (Get-Process -Name braid -ErrorAction SilentlyContinue)) 'the background server stops with the app' 'braid.exe still running'

if ($failed) { Write-Host "`n$failed check(s) failed"; exit 1 } else { Write-Host "`nall desktop checks passed" }
