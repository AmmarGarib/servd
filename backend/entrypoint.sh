#!/bin/sh
# Container startup wrapper. Restored to match deploy/docker-compose.yml's
# documented expectation:
#
#   0. practice copy only: the sandbox boot check   (before any migration)
#   1. prisma migrate resolve --applied 0_init   (idempotent baseline tag)
#   2. prisma migrate deploy                      (apply any new migrations)
#   3. node dist/src/index.js                     (boot the API)
#
# There is deliberately NO PIN reconciliation step any more. Staff choose their
# own PIN (signup / POST /auth/pin/change) and the CEO issues a temporary one
# on "forgot PIN" — a boot-time pass that rewrote every PIN to phone-last-4
# would silently undo both on every deploy.
#
# The baseline resolve is best-effort (it's expected to no-op once applied).
# migrate deploy, however, is FATAL on failure: booting the API against a stale
# schema silently serves wrong data (incl. financial totals) mid-service, which
# is far worse than a visibly-failed deploy the operator can roll back. `migrate
# deploy` is idempotent — a non-zero exit means a real migration failure.

set -u

# Practice copy (deploy/sandbox): the boot check runs BEFORE any migration. It
# refuses a malformed SERVD_SANDBOX and a DATABASE_URL / REDIS_URL on a live
# host (SERVD_PROD_HOSTS) — a live connection string pasted into the practice
# .env must never have this image's newer migrations applied to it. Live
# leaves SERVD_SANDBOX unset, so this is skipped there. Gated on "set at all"
# (not = "1") so a stray '1 ' / '1\r' is refused here too. index.ts runs the
# same check again as the second layer.
if [ -n "${SERVD_SANDBOX:-}" ]; then
  echo "[entrypoint] practice-copy boot check before any migration…"
  node -e "import('./dist/src/lib/sandbox.js').then((m) => m.assertSandboxBoot()).catch((e) => { console.error('[sandbox] FATAL: ' + e.message); process.exit(1) })" || exit 1
fi

echo "[entrypoint] resolving 0_init baseline (idempotent)…"
npx prisma migrate resolve --applied 0_init 2>&1 || \
  echo "[entrypoint] migrate resolve returned non-zero (often expected if already applied), continuing"

echo "[entrypoint] applying any new migrations…"
if ! npx prisma migrate deploy 2>&1; then
  echo "[entrypoint] FATAL: prisma migrate deploy failed — refusing to boot against a stale schema. Roll back or fix the migration."
  exit 1
fi

echo "[entrypoint] starting API…"
exec node dist/src/index.js
