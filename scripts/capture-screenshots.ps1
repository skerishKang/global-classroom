# Global Classroom - README용 스크린샷 생성 스크립트
# - Edge(Chromium) 헤드리스 모드로 Netlify 배포 화면을 캡처합니다.

$ErrorActionPreference = 'Stop'

$siteUrl = 'https://7-global-classroom.netlify.app'
$outDir = Join-Path $PSScriptRoot '..\docs\screenshots'

New-Item -ItemType Directory -Force $outDir | Out-Null

$edgePath = $null

try {
  $edgePath = (Get-Command msedge -ErrorAction SilentlyContinue).Source
} catch {
  $edgePath = $null
}

if (-not $edgePath) {
  $pf86 = $null
  try { $pf86 = ${env:ProgramFiles(x86)} } catch { $pf86 = $null }

  $edgeCandidates = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    ($(if ($pf86) { Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe' } else { $null })),
    (Join-Path $env:LocalAppData 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  $edgePath = $edgeCandidates | Select-Object -First 1
}

if (-not $edgePath) {
  Write-Error 'msedge.exe를 찾지 못했습니다. Edge가 설치되어 있는지 확인해주세요.'
}

$homePng = Join-Path $outDir 'home.png'

$homeMobilePng = Join-Path $outDir 'home-mobile.png'

& $edgePath --headless --disable-gpu --window-size=1440,900 --hide-scrollbars --screenshot=$homePng $siteUrl | Out-Null

& $edgePath --headless --disable-gpu --window-size=390,844 --hide-scrollbars --screenshot=$homeMobilePng $siteUrl | Out-Null

Write-Output ("스크린샷 생성 완료: {0}" -f $homePng)
Write-Output ("스크린샷 생성 완료: {0}" -f $homeMobilePng)
