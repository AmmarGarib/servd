#!/usr/bin/env bash
# Run the suite with the live company lock ON (TEST_RLS=1 — see
# tests/rls/rlsMode.ts): row-level security replayed from the migrations, the
# app connected as a plain role (servd_test_rls) with RLS_ENFORCE=1.
#
#   npm run test:rls                          # every test file except tests/rls/exclude.txt
#   npm run test:rls -- --shard=1/4           # same, one shard (CI)
#   npm run test:rls -- tests/foo.test.ts     # just these files
#
# Needs the usual test env (DATABASE_URL containing "test", REDIS_URL, JWT_*),
# and a DATABASE_URL user that may CREATE ROLE (the postgres superuser does).
set -euo pipefail
cd "$(dirname "$0")/.."
files=(); flags=()
for a in "$@"; do
  case "$a" in *.test.ts) files+=("$a") ;; *) flags+=("$a") ;; esac
done
if [ "${#files[@]}" -eq 0 ]; then
  mapfile -t files < <(
    find tests src -name '*.test.ts' | sort \
      | grep -vxFf <(grep -vE '^\s*(#|$)' tests/rls/exclude.txt | awk '{print $1}')
  )
fi
TEST_RLS=1 exec npx vitest run "${flags[@]}" "${files[@]}"
