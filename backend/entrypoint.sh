#!/bin/sh
# Container startup wrapper. Restored to match deploy/docker-compose.yml's
# documented expectation:
#
#   1. prisma migrate resolve --applied 0_init   (idempotent baseline tag)
#   2. prisma migrate deploy                      (apply any new migrations)
#   3. node dist/src/index.js                     (boot the API)
#
# Each migration step is best-effort. A non-zero exit (baseline already
# applied, transient DB blip, etc.) logs and continues so the API still
# boots against the existing schema — the previous shell-and-chain command
# crashed the container whenever migrate-deploy returned non-zero.

set -u

echo "[entrypoint] resolving 0_init baseline (idempotent)…"
npx prisma migrate resolve --applied 0_init 2>&1 || \
  echo "[entrypoint] migrate resolve returned non-zero (often expected if already applied), continuing"

echo "[entrypoint] applying any new migrations…"
npx prisma migrate deploy 2>&1 || \
  echo "[entrypoint] migrate deploy returned non-zero, continuing — API will run against existing schema"

echo "[entrypoint] starting API…"
exec node dist/src/index.js
