#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build + push the PRACTICE COPY admin image:
#   ammargarib/servd:admin-sandbox            (what deploy/sandbox/docker-compose.yml runs)
#   ammargarib/servd:admin-sandbox-<sha>      (an immutable tag to pin with SANDBOX_ADMIN_TAG)
#
# Baked in at build time (Next.js inlines NEXT_PUBLIC_* into the bundle):
#   NEXT_PUBLIC_API_URL=https://sandbox-api.servd.pk
#   NEXT_PUBLIC_WS_URL=wss://sandbox-api.servd.pk
#   NEXT_PUBLIC_SANDBOX=1           (the "PRACTICE COPY" stripe from the first paint)
#   NEXT_PUBLIC_SENTRY_DSN=         (empty: the practice copy reports nothing to Sentry)
#
# The addresses are fixed in this script on purpose — there is no way to point
# a practice image at the live API, and no way to push it under a live tag
# (admin / admin-<sha>). It reads no secrets: run `docker login` first (a
# Docker Hub access token), the same login CI uses.
#
# Usage (from anywhere in the repo):
#   deploy/sandbox/build-admin.sh            build, check, push
#   deploy/sandbox/build-admin.sh --no-push  build and check only
#
# The image is built from the CURRENT working tree of frontend/admin. With
# uncommitted changes there the immutable tag gets a "-dirty" suffix.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PUSH=1
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "[practice] unknown option: $arg (use --no-push or --help)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTEXT="$REPO_ROOT/frontend/admin"
DOCKERFILE="$CONTEXT/Dockerfile"

IMAGE_REPO="ammargarib/servd"
PRACTICE_API_URL="https://sandbox-api.servd.pk"
PRACTICE_WS_URL="wss://sandbox-api.servd.pk"
LIVE_API_HOST="api.servd.pk"

[ -f "$DOCKERFILE" ] || { echo "[practice] $DOCKERFILE not found" >&2; exit 1; }
command -v docker >/dev/null || { echo "[practice] docker is not installed" >&2; exit 1; }

SHA="$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- frontend/admin)" ]; then
  SHA="$SHA-dirty"
  echo "[practice] note: frontend/admin has uncommitted changes; tagging admin-sandbox-$SHA"
fi
TAG_MOVING="admin-sandbox"
TAG_PINNED="admin-sandbox-$SHA"

# Never a live tag.
for t in "$TAG_MOVING" "$TAG_PINNED"; do
  case "$t" in
    admin-sandbox|admin-sandbox-*) ;;
    *) echo "[practice] refusing to use tag '$t' (only admin-sandbox tags)" >&2; exit 1 ;;
  esac
done

# NEXT_PUBLIC_SANDBOX only reaches the bundle if the builder stage declares it.
# If frontend/admin/Dockerfile doesn't (yet), build from a copy of it with the
# ARG added after the Sentry DSN line — the live Dockerfile is not changed.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUILD_FILE="$DOCKERFILE"
if ! grep -qE '^ARG[[:space:]]+NEXT_PUBLIC_SANDBOX([[:space:]=]|$)' "$DOCKERFILE"; then
  BUILD_FILE="$WORK/Dockerfile.practice"
  awk '
    { print }
    /^ENV[[:space:]]+NEXT_PUBLIC_SENTRY_DSN=/ && !done {
      print "ARG NEXT_PUBLIC_SANDBOX"
      print "ENV NEXT_PUBLIC_SANDBOX=$NEXT_PUBLIC_SANDBOX"
      done = 1
    }
  ' "$DOCKERFILE" > "$BUILD_FILE"
  if [ "$(grep -cE '^ARG[[:space:]]+NEXT_PUBLIC_SANDBOX$' "$BUILD_FILE")" != "1" ]; then
    echo "[practice] could not add NEXT_PUBLIC_SANDBOX to the build (the Dockerfile changed shape)." >&2
    echo "[practice] Add 'ARG NEXT_PUBLIC_SANDBOX' + 'ENV NEXT_PUBLIC_SANDBOX=\$NEXT_PUBLIC_SANDBOX' to the builder stage of frontend/admin/Dockerfile." >&2
    exit 1
  fi
  echo "[practice] frontend/admin/Dockerfile has no NEXT_PUBLIC_SANDBOX ARG; building from a copy with it added"
fi
# The ARG must come before the build step, or it is set too late to be inlined.
arg_line="$(grep -nE '^ARG[[:space:]]+NEXT_PUBLIC_SANDBOX' "$BUILD_FILE" | head -1 | cut -d: -f1)"
build_line="$(grep -nE '^RUN[[:space:]]+npm run build' "$BUILD_FILE" | head -1 | cut -d: -f1)"
if [ -z "$arg_line" ] || [ -z "$build_line" ] || [ "$arg_line" -ge "$build_line" ]; then
  echo "[practice] NEXT_PUBLIC_SANDBOX is not declared before 'RUN npm run build' in the builder stage" >&2
  exit 1
fi

echo "[practice] building $IMAGE_REPO:$TAG_MOVING and :$TAG_PINNED"
echo "[practice]   NEXT_PUBLIC_API_URL=$PRACTICE_API_URL  NEXT_PUBLIC_WS_URL=$PRACTICE_WS_URL  NEXT_PUBLIC_SANDBOX=1"
docker build \
  --platform linux/amd64 \
  --file "$BUILD_FILE" \
  --build-arg "NEXT_PUBLIC_API_URL=$PRACTICE_API_URL" \
  --build-arg "NEXT_PUBLIC_WS_URL=$PRACTICE_WS_URL" \
  --build-arg "NEXT_PUBLIC_SANDBOX=1" \
  --build-arg "NEXT_PUBLIC_SENTRY_DSN=" \
  --label "pk.servd.practice=1" \
  --label "pk.servd.api-url=$PRACTICE_API_URL" \
  --label "org.opencontainers.image.revision=$SHA" \
  --tag "$IMAGE_REPO:$TAG_MOVING" \
  --tag "$IMAGE_REPO:$TAG_PINNED" \
  "$CONTEXT"

# ── Check the built image before it goes anywhere ────────────────────────────
# The practice API address must be in the bundle, and the live API address
# must not be (an image that talks to the live API is never pushed as a
# practice image).
echo "[practice] checking the built bundle"
check="$(docker run --rm --platform linux/amd64 --entrypoint sh "$IMAGE_REPO:$TAG_MOVING" -c '
  has_practice=0; has_live=0
  grep -rqsF "https://sandbox-api.servd.pk" .next server.js 2>/dev/null && has_practice=1
  grep -rqsE "(https|wss)://'"$LIVE_API_HOST"'" .next server.js 2>/dev/null && has_live=1
  echo "$has_practice $has_live"
')"
read -r has_practice has_live <<<"$check"
if [ "$has_practice" != "1" ]; then
  echo "[practice] REFUSED: the bundle does not contain $PRACTICE_API_URL — not pushing." >&2
  exit 1
fi
if [ "$has_live" != "0" ]; then
  echo "[practice] REFUSED: the bundle still contains the live API address ($LIVE_API_HOST) — not pushing." >&2
  exit 1
fi
echo "[practice] bundle OK: talks to $PRACTICE_API_URL only"

if [ "$PUSH" = "0" ]; then
  echo "[practice] --no-push: built $IMAGE_REPO:$TAG_MOVING and :$TAG_PINNED, not pushed"
  exit 0
fi

docker push "$IMAGE_REPO:$TAG_PINNED"
docker push "$IMAGE_REPO:$TAG_MOVING"
echo "[practice] pushed $IMAGE_REPO:$TAG_MOVING and $IMAGE_REPO:$TAG_PINNED"
echo "[practice] on the box: C:\\servd-sandbox\\update.bat"
