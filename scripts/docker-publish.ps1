# servd — build all 3 images and push to private Docker Hub repo (single repo, 3 tags).
#
# Usage:
#   .\scripts\docker-publish.ps1                          # uses ammargarib/servd
#   .\scripts\docker-publish.ps1 -Repo me/servd            # custom repo
#   .\scripts\docker-publish.ps1 -SkipPush                # build only
#   .\scripts\docker-publish.ps1 -Version v1.0.0          # also tag with version
#
# Prereqs:
#   - Docker Desktop running
#   - `docker login` already done with an account that owns -Repo
#   - Run from repo root: c:\Dev\servd

param(
    [string]$Repo = "ammargarib/servd",

    [string]$Version = "",  # optional extra tag, e.g. "v1.0.0"

    [string]$PublicApiUrl = "http://localhost:3001",
    [string]$PublicWsUrl  = "http://localhost:3001",

    [switch]$SkipPush
)

$ErrorActionPreference = "Stop"

# tagName = part after the colon. 3 services map to 3 tags on the same repo.
$variants = @(
    @{ Tag = "api";        Context = "backend";             BuildArgs = @() },
    @{ Tag = "admin";      Context = "frontend/admin";      BuildArgs = @("--build-arg", "NEXT_PUBLIC_API_URL=$PublicApiUrl", "--build-arg", "NEXT_PUBLIC_WS_URL=$PublicWsUrl") },
    @{ Tag = "storefront"; Context = "frontend/storefront"; BuildArgs = @("--build-arg", "NEXT_PUBLIC_API_URL=$PublicApiUrl", "--build-arg", "NEXT_PUBLIC_WS_URL=$PublicWsUrl") }
)

Write-Host "Building 3 image variants under repo: $Repo" -ForegroundColor Cyan

foreach ($v in $variants) {
    $imageRef = "${Repo}:$($v.Tag)"
    Write-Host ""
    Write-Host "── Build $imageRef ──" -ForegroundColor Yellow
    & docker build -t $imageRef @($v.BuildArgs) $v.Context
    if ($LASTEXITCODE -ne 0) { throw "Build failed for $imageRef" }

    if ($Version -ne "") {
        $versionRef = "${Repo}:$($v.Tag)-$Version"
        & docker tag $imageRef $versionRef
        Write-Host "  also tagged $versionRef" -ForegroundColor DarkGray
    }
}

if ($SkipPush) {
    Write-Host ""
    Write-Host "Build complete. Skipped push (--SkipPush)." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "── Pushing all tags to $Repo ──" -ForegroundColor Cyan

foreach ($v in $variants) {
    $imageRef = "${Repo}:$($v.Tag)"
    Write-Host ""
    Write-Host "Push $imageRef" -ForegroundColor Yellow
    & docker push $imageRef
    if ($LASTEXITCODE -ne 0) { throw "Push failed for $imageRef — check repo exists and is writable" }

    if ($Version -ne "") {
        $versionRef = "${Repo}:$($v.Tag)-$Version"
        & docker push $versionRef
        if ($LASTEXITCODE -ne 0) { throw "Push failed for $versionRef" }
    }
}

Write-Host ""
Write-Host "Done. Pushed: ${Repo}:api, ${Repo}:admin, ${Repo}:storefront" -ForegroundColor Green
Write-Host "On the target machine: docker compose pull && docker compose up -d" -ForegroundColor Green
