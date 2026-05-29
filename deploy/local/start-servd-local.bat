@echo off
REM ============================================================================
REM  servd -- one-double-click local launcher (Windows)
REM
REM  For a laptop with NOTHING set up. Double-click this file. It will:
REM    1. Install Git + Docker Desktop (via winget) if they're missing
REM    2. Download the servd code from GitHub
REM    3. Boot the whole app locally (api + admin + storefront + db + redis)
REM    4. Open the storefront in your browser
REM
REM  If Docker Desktop gets installed on this run, Windows needs a REBOOT.
REM  After rebooting, just double-click this file again -- it picks up where it
REM  left off and boots the app.
REM ============================================================================

setlocal enabledelayedexpansion
title servd local launcher
color 0B

set "REPO_URL=https://github.com/AmmarGarib/servd.git"
set "BRANCH=claude/docker-changes-sync-1GmEZ"
set "INSTALL_DIR=%USERPROFILE%\servd"
set "COMPOSE_FILE=docker-compose.local.yml"

echo(
echo  ===========================================================
echo   servd local launcher
echo  ===========================================================
echo(

REM --- winget present? -------------------------------------------------------
where winget >nul 2>&1
if errorlevel 1 (
  echo  [X] Windows Package Manager ^(winget^) is not available.
  echo      Open Microsoft Store, update "App Installer", then re-run this file.
  echo(
  pause
  exit /b 1
)

REM --- Git -------------------------------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo  [*] Installing Git ...
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  echo  [!] Git installed. If the next steps fail, reboot and re-run this file.
  REM refresh PATH for this session
  set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
) else (
  echo  [ok] Git is installed.
)

REM --- Docker ----------------------------------------------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo  [*] Installing Docker Desktop ... ^(this is a big download^)
  winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
  echo(
  echo  ===========================================================
  echo   Docker Desktop was just installed.
  echo   >>> RESTART your laptop now, then double-click this file again. <<<
  echo  ===========================================================
  echo(
  pause
  exit /b 0
) else (
  echo  [ok] Docker is installed.
)

REM --- Get the code ----------------------------------------------------------
if not exist "%INSTALL_DIR%\%COMPOSE_FILE%" (
  if exist "%INSTALL_DIR%\.git" (
    echo  [*] Updating existing servd copy ...
    pushd "%INSTALL_DIR%"
  ) else (
    echo  [*] Downloading servd from GitHub ...
    echo      ^(a browser window may open asking you to sign in to GitHub^)
    git clone "%REPO_URL%" "%INSTALL_DIR%"
    if errorlevel 1 (
      echo  [X] Download failed. Check your internet / GitHub sign-in and re-run.
      pause
      exit /b 1
    )
    pushd "%INSTALL_DIR%"
  )
) else (
  pushd "%INSTALL_DIR%"
)

echo  [*] Getting the latest local-dev setup ...
git fetch origin %BRANCH% >nul 2>&1
git checkout %BRANCH% >nul 2>&1
git pull origin %BRANCH% >nul 2>&1

REM --- Make sure the Docker engine is actually running ------------------------
echo  [*] Checking Docker engine ...
docker info >nul 2>&1
if errorlevel 1 (
  echo  [*] Starting Docker Desktop ... ^(waiting up to ~2 min for it to be ready^)
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" >nul 2>&1
  set /a tries=0
  :waitdocker
  timeout /t 5 /nobreak >nul
  docker info >nul 2>&1
  if not errorlevel 1 goto dockerready
  set /a tries+=1
  if !tries! lss 24 (
    echo      ... still starting Docker ^(!tries!/24^)
    goto waitdocker
  )
  echo  [X] Docker engine did not start. Open Docker Desktop manually, wait for
  echo      it to say "Engine running", then re-run this file.
  pause
  exit /b 1
)
:dockerready
echo  [ok] Docker engine is running.

REM --- Boot the app ----------------------------------------------------------
echo(
echo  [*] Building and starting servd ^(first run takes a few minutes^) ...
docker compose -f "%COMPOSE_FILE%" up -d
if errorlevel 1 (
  echo  [X] Failed to start. Showing recent logs:
  docker compose -f "%COMPOSE_FILE%" logs --tail=40
  pause
  exit /b 1
)

REM --- Wait until the storefront answers on :3002, then open the browser ------
echo  [*] Waiting for the storefront to come up on http://localhost:3002 ...
set /a tries=0
:waitweb
timeout /t 5 /nobreak >nul
curl -s -o nul http://localhost:3002 && goto webready
set /a tries+=1
if !tries! lss 120 (
  echo      ... still building/starting ^(!tries!/120^) -- this is normal on first run
  goto waitweb
)
echo  [!] Took longer than expected. It may still be building. Opening anyway --
echo      if you see "can't reach this page", wait a minute and refresh.
:webready
echo(
echo  ===========================================================
echo   servd is starting up. Opening your browser:
echo     Storefront : http://localhost:3002
echo     Admin      : http://localhost:3000
echo  ===========================================================
start "" "http://localhost:3002"
echo(
echo  To stop the app later: run  stop-servd-local.bat  in %INSTALL_DIR%\deploy\local
echo  Leave this window; you can close it once the page loads.
echo(
pause
popd
endlocal
