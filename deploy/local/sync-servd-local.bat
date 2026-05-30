@echo off
REM ============================================================================
REM  servd -- live sync (Windows)
REM
REM  Keeps this laptop's code in sync with GitHub so changes you push from
REM  Claude Code (phone or web) show up live on localhost via hot reload.
REM
REM  Leave this window OPEN while you work. It pulls every 15 seconds.
REM  Press Ctrl+C to stop.
REM ============================================================================
setlocal enabledelayedexpansion
title servd -- live sync
cd /d "%USERPROFILE%\servd"

for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"

echo  ===========================================================
echo   servd live sync -- watching GitHub branch: !BRANCH!
echo   Pulls new changes every 15s. Keep this window open.
echo   Edits you push from your phone appear on localhost shortly.
echo  ===========================================================
echo(

:loop
git pull --ff-only origin !BRANCH!
timeout /t 15 /nobreak >nul
goto loop
