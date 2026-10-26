# Weekly Docker clean-up for the Windows box (owner, 2026-10-26, S16a).
#
# Removes ONLY what is safe to lose:
#   - images no container uses (running OR stopped) that are older than 7 days
#   - build cache older than 7 days
#   - stopped containers older than 7 days
# NEVER: volumes (the database and Redis live in volumes), networks in use,
# any image a container still uses, anything newer than 7 days (so the
# rollback tags of the last release stay).
#
# `docker image prune -a` / `docker builder prune` skip images used by any
# container; --filter "until=168h" adds the 7-day floor. There is deliberately
# no `docker volume prune` and no `docker system prune --volumes` here.
#
# Run by the scheduled task from register-docker-cleanup.ps1; safe to run by hand.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'docker-cleanup.log'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Tee-Object -FilePath $log -Append }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Log 'docker not found - nothing done'; exit 1 }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Log 'Docker is not running - nothing done'; exit 1 }

Log 'start'
Log 'stopped containers older than 7 days'
docker container prune -f --filter "until=168h" 2>&1 | ForEach-Object { Log $_ }
Log 'unused images older than 7 days'
docker image prune -a -f --filter "until=168h" 2>&1 | ForEach-Object { Log $_ }
Log 'build cache older than 7 days'
docker builder prune -f --filter "until=168h" 2>&1 | ForEach-Object { Log $_ }
Log 'done (volumes untouched)'
# Keep the log small.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Get-Content $log -Tail 500 | Set-Content $log }
