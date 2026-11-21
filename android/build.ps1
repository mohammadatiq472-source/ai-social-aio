# Rebuild the AIO WebView shell APKs.
# ASCII-only on purpose: Windows PowerShell reads UTF-8-without-BOM scripts as ANSI,
# and non-ASCII comments can corrupt the next line.
#
# Usage:
#   pwsh -File android\build.ps1            # debug + release
#   pwsh -File android\build.ps1 -Task debug
#   pwsh -File android\build.ps1 -Task lint
param(
    [ValidateSet('debug', 'release', 'both', 'clean', 'lint')]
    [string]$Task = 'both'
)

$ErrorActionPreference = 'Stop'

$env:JAVA_HOME         = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
$env:ANDROID_HOME      = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT  = 'D:\Android\Sdk'
$env:GRADLE_USER_HOME  = 'D:\gradle\home'   # keep the big caches off C:

$gradle  = 'D:\gradle\gradle-8.9\bin\gradle.bat'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
# Keep in sync with versionName in app/build.gradle (dist file names follow it).
$version = '0.1.1'

switch ($Task) {
    'debug'   { & $gradle -p $project --console=plain assembleDebug }
    'release' { & $gradle -p $project --console=plain assembleRelease }
    'both'    { & $gradle -p $project --console=plain assembleDebug assembleRelease }
    'clean'   { & $gradle -p $project --console=plain clean }
    'lint'    { & $gradle -p $project --console=plain lintRelease }
}
if ($LASTEXITCODE -ne 0) {
    throw "gradle failed with exit code $LASTEXITCODE"
}

if ($Task -in @('debug', 'release', 'both')) {
    $dist = Join-Path $project 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $debugApk   = Join-Path $project 'app\build\outputs\apk\debug\app-debug.apk'
    $releaseApk = Join-Path $project 'app\build\outputs\apk\release\app-release.apk'
    if (($Task -in @('debug', 'both')) -and (Test-Path $debugApk)) {
        Copy-Item $debugApk (Join-Path $dist "AIO-$version-debug.apk") -Force
    }
    if (($Task -in @('release', 'both')) -and (Test-Path $releaseApk)) {
        Copy-Item $releaseApk (Join-Path $dist "AIO-$version-release.apk") -Force
    }
    Get-ChildItem $dist | ForEach-Object {
        '{0,-28} {1,9:N0} bytes  sha256={2}' -f $_.Name, $_.Length, (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    }
}
