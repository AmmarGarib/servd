@echo off
REM ==========================================================================
REM  servd PRACTICE COPY - update to the latest practice images and (re)start.
REM
REM  Lives in the practice folder (C:\servd-sandbox), next to docker-compose.yml
REM  and .env. Double-click it, or run "update.bat /nopause" from a script.
REM  Touches ONLY the servd-sandbox project; the live ERP is never affected.
REM ==========================================================================
setlocal
cd /d "%~dp0"

REM Refuse to run anywhere but the practice folder.
if not exist "docker-compose.yml" (
  echo [practice] docker-compose.yml is not in %CD%. Put update.bat in the practice folder ^(C:\servd-sandbox^).
  goto :fail
)
findstr /b /c:"name: servd-sandbox" "docker-compose.yml" >nul
if errorlevel 1 (
  echo [practice] %CD%\docker-compose.yml is not the practice copy's compose file. Stopping - nothing was changed.
  goto :fail
)
if not exist ".env" (
  echo [practice] .env is missing. Copy .env.example to .env and fill it in ^(SETUP.md step 3^).
  goto :fail
)

echo [practice] Pulling the latest practice images...
docker compose -p servd-sandbox pull
if errorlevel 1 goto :fail_up

echo [practice] Starting the practice copy. This waits until the API has run its migrations and proved it is in practice mode - a few minutes.
docker compose -p servd-sandbox up -d
if errorlevel 1 goto :fail_up

echo.
docker compose -p servd-sandbox ps
echo.
echo [practice] Done. Open https://servd-practice.garibsons.app
echo [practice] API log:  docker compose -p servd-sandbox logs -f sandbox-api
goto :end

:fail_up
REM A failed pull / start: take the tunnel and the admin down, so nothing
REM outside can reach an API that has not proved it is in practice mode.
echo [practice] Stopping the practice tunnel and admin until the API starts cleanly...
docker compose -p servd-sandbox stop sandbox-cloudflared sandbox-admin

:fail
echo.
echo [practice] FAILED - see the messages above. The live ERP was not touched.
echo [practice] If sandbox-api is "unhealthy", it did not start in practice mode or its migrations failed:
echo [practice]   docker compose -p servd-sandbox logs sandbox-api
if /i not "%~1"=="/nopause" pause
exit /b 1

:end
if /i not "%~1"=="/nopause" pause
exit /b 0
