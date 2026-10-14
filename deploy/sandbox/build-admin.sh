#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build + push the PRACTICE COPY admin image:
#   ammargarib/servd:admin-sandbox            (what deploy/sandbox/docker-compose.yml runs)
#   ammargarib/servd:admin-sandbox-<sha>      (an immutable tag to pin with SANDBOX_ADMIN_TAG)
#
# Baked in at build time (Next.js inlines NEXT_PUBLIC_* into the bundle):
#   NEXT_PUBLIC_API_URL=https://servd-practice-api.garibsons.app
#   NEXT_PUBLIC_WS_URL=wss://servd-practice-api.garibsons.app
#   NEXT_PUBLIC_STOREFRONT_URL=https://servd-practice.garibsons.app
#                                   (the practice copy has no storefront: the
#                                   editor's live page, the sections catalogue
#                                   and preview links stay on the practice
#                                   address, never servd.pk)
#   NEXT_PUBLIC_SANDBOX=1           (the "PRACTICE COPY" stripe from the first paint)
#   NEXT_PUBLIC_SENTRY_DSN=         (empty: the practice copy reports nothing to Sentry)
#
# The practice copy is NOT on servd.pk, on purpose: an address under servd.pk
# is the "same site" as the live API in the browser, so live's sign-in cookies
# would ride along on every request a practice page makes to api.servd.pk, and
# the live API's CORS allowlist trusts every *.servd.pk origin.
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
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "[practice] unknown option: $arg (use --no-push or --help)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTEXT="$REPO_ROOT/frontend/admin"
DOCKERFILE="$CONTEXT/Dockerfile"

IMAGE_REPO="ammargarib/servd"
PRACTICE_ADMIN_URL="https://servd-practice.garibsons.app"
PRACTICE_API_URL="https://servd-practice-api.garibsons.app"
PRACTICE_WS_URL="wss://servd-practice-api.garibsons.app"
LIVE_API_HOST="api.servd.pk"

# Never on servd.pk (see the header). Also guards a future edit of the lines above.
for u in "$PRACTICE_ADMIN_URL" "$PRACTICE_API_URL" "$PRACTICE_WS_URL"; do
  host="${u#*://}"; host="${host%%/*}"; host="${host%%:*}"
  case "$host" in
    servd.pk|*.servd.pk)
      echo "[practice] refusing $u: the practice copy must not live under servd.pk (the browser would treat it as the same site as the live API)." >&2
      exit 1 ;;
  esac
done

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

# A NEXT_PUBLIC_* value only reaches the bundle if the builder stage declares
# it. frontend/admin/Dockerfile declares API_URL / WS_URL / SENTRY_DSN; for any
# of the practice-only ones it doesn't (yet) declare, build from a copy of it
# with the ARG + ENV added after the Sentry DSN line — the live Dockerfile is
# not changed.
PRACTICE_VARS=(NEXT_PUBLIC_SANDBOX NEXT_PUBLIC_STOREFRONT_URL)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUILD_FILE="$DOCKERFILE"
MISSING=()
for v in "${PRACTICE_VARS[@]}"; do
  grep -qE "^ARG[[:space:]]+$v([[:space:]=]|\$)" "$DOCKERFILE" || MISSING+=("$v")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  BUILD_FILE="$WORK/Dockerfile.practice"
  awk -v vars="${MISSING[*]}" '
    { print }
    /^ENV[[:space:]]+NEXT_PUBLIC_SENTRY_DSN=/ && !done {
      n = split(vars, v, " ")
      for (i = 1; i <= n; i++) { print "ARG " v[i]; print "ENV " v[i] "=$" v[i] }
      done = 1
    }
  ' "$DOCKERFILE" > "$BUILD_FILE"
  echo "[practice] frontend/admin/Dockerfile does not declare ${MISSING[*]}; building from a copy with them added"
fi
# Each must be declared before the build step, or it is set too late to be inlined.
build_line="$(grep -nE '^RUN[[:space:]]+npm run build' "$BUILD_FILE" | head -1 | cut -d: -f1)"
for v in "${PRACTICE_VARS[@]}"; do
  arg_line="$(grep -nE "^ARG[[:space:]]+$v([[:space:]=]|\$)" "$BUILD_FILE" | head -1 | cut -d: -f1)"
  if [ -z "$arg_line" ] || [ -z "$build_line" ] || [ "$arg_line" -ge "$build_line" ]; then
    echo "[practice] could not declare $v before 'RUN npm run build' in the builder stage (the Dockerfile changed shape)." >&2
    echo "[practice] Add 'ARG $v' + 'ENV $v=\$$v' to the builder stage of frontend/admin/Dockerfile." >&2
    exit 1
  fi
done

echo "[practice] building $IMAGE_REPO:$TAG_MOVING and :$TAG_PINNED"
echo "[practice]   NEXT_PUBLIC_API_URL=$PRACTICE_API_URL  NEXT_PUBLIC_WS_URL=$PRACTICE_WS_URL"
echo "[practice]   NEXT_PUBLIC_STOREFRONT_URL=$PRACTICE_ADMIN_URL  NEXT_PUBLIC_SANDBOX=1"
docker build \
  --platform linux/amd64 \
  --file "$BUILD_FILE" \
  --build-arg "NEXT_PUBLIC_API_URL=$PRACTICE_API_URL" \
  --build-arg "NEXT_PUBLIC_WS_URL=$PRACTICE_WS_URL" \
  --build-arg "NEXT_PUBLIC_STOREFRONT_URL=$PRACTICE_ADMIN_URL" \
  --build-arg "NEXT_PUBLIC_SANDBOX=1" \
  --build-arg "NEXT_PUBLIC_SENTRY_DSN=" \
  --label "pk.servd.practice=1" \
  --label "pk.servd.api-url=$PRACTICE_API_URL" \
  --label "pk.servd.admin-url=$PRACTICE_ADMIN_URL" \
  --label "org.opencontainers.image.revision=$SHA" \
  --tag "$IMAGE_REPO:$TAG_MOVING" \
  --tag "$IMAGE_REPO:$TAG_PINNED" \
  "$CONTEXT"

# ── Check the built image before it goes anywhere ────────────────────────────
# The practice API and practice storefront addresses must be in the bundle,
# and the live API address must not be (an image that talks to the live API
# is never pushed as a practice image).
echo "[practice] checking the built bundle"
check="$(docker run --rm --platform linux/amd64 --entrypoint sh "$IMAGE_REPO:$TAG_MOVING" -c '
  has_api=0; has_storefront=0; has_live=0
  grep -rqsF "'"$PRACTICE_API_URL"'" .next server.js 2>/dev/null && has_api=1
  grep -rqsF "'"$PRACTICE_ADMIN_URL"'" .next server.js 2>/dev/null && has_storefront=1
  grep -rqsE "(https|wss)://'"$LIVE_API_HOST"'" .next server.js 2>/dev/null && has_live=1
  echo "$has_api $has_storefront $has_live"
')"
read -r has_api has_storefront has_live <<<"$check"
if [ "$has_api" != "1" ]; then
  echo "[practice] REFUSED: the bundle does not contain $PRACTICE_API_URL — not pushing." >&2
  exit 1
fi
if [ "$has_storefront" != "1" ]; then
  echo "[practice] REFUSED: the bundle does not contain the practice storefront address ($PRACTICE_ADMIN_URL) — not pushing." >&2
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
