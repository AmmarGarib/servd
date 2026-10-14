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
if errorlevel 1 goto :fail

echo [practice] Starting the practice copy...
docker compose -p servd-sandbox up -d
if errorlevel 1 goto :fail

echo.
docker compose -p servd-sandbox ps
echo.
echo [practice] Done. Open https://sandbox.servd.pk - the API runs its database migrations first, so give it a minute.
echo [practice] Watch it start:  docker compose -p servd-sandbox logs -f sandbox-api
goto :end

:fail
echo.
echo [practice] FAILED - see the messages above. The live ERP was not touched.
if /i not "%~1"=="/nopause" pause
exit /b 1

:end
if /i not "%~1"=="/nopause" pause
exit /b 0
