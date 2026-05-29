@echo off
REM Stop the local servd app (leaves your data intact).
setlocal
title servd -- stop local
cd /d "%USERPROFILE%\servd"
echo Stopping servd local stack ...
docker compose -f docker-compose.local.yml down
echo Done. Data is kept. Run start-servd-local.bat to bring it back.
pause
endlocal
