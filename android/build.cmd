@echo off
REM Wrapper so the build works even when PowerShell script execution is restricted
REM (RemoteSigned still blocks .ps1 in some synced folders). Pass -Task debug|release|both|lint|clean.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
if errorlevel 1 exit /b 1
