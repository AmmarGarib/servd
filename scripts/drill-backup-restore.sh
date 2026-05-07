#!/usr/bin/env bash
#
# RDS backup-restore drill.
#
# What it does:
#   1. Snapshots the staging RDS instance.
#   2. Restores that snapshot to a temporary instance (different identifier).
#   3. Connects to the temp instance and runs the trial balance — proving the
#      backup is restorable AND the books still tie on restore.
#   4. Tears the temp instance down.
#
# This is the only honest way to know your backups work. AWS marking a backup
# "completed" does not prove you can restore it. Run this monthly minimum.
#
# Prereqs:
#   - aws cli configured for the staging account
#   - psql in PATH
#   - Read access to the staging DB password (script reads from SSM)
#
# Usage:
#   ./drill-backup-restore.sh staging
#   ./drill-backup-restore.sh production    # only with explicit consent

set -euo pipefail

ENV="${1:-staging}"
APP_NAME="servd"
if [ "$ENV" = "staging" ]; then
  SOURCE_DB="${APP_NAME}-staging-postgres"
elif [ "$ENV" = "production" ]; then
  SOURCE_DB="${APP_NAME}-postgres"
else
  echo "Usage: $0 [staging|production]" >&2
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_ID="${SOURCE_DB}-drill-${TS}"
RESTORED_ID="${SOURCE_DB}-drill-restore-${TS}"
REGION="${AWS_REGION:-ap-south-1}"

cleanup() {
  echo
  echo "── Cleanup ──"
  aws rds delete-db-instance --db-instance-identifier "$RESTORED_ID" \
    --skip-final-snapshot --region "$REGION" 2>/dev/null || true
  aws rds delete-db-snapshot --db-snapshot-identifier "$SNAPSHOT_ID" \
    --region "$REGION" 2>/dev/null || true
  echo "Cleanup complete."
}
trap cleanup EXIT

echo "── Step 1: snapshot $SOURCE_DB → $SNAPSHOT_ID ──"
aws rds create-db-snapshot \
  --db-instance-identifier "$SOURCE_DB" \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region "$REGION" >/dev/null
aws rds wait db-snapshot-completed \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --region "$REGION"
echo "Snapshot ready."

echo
echo "── Step 2: restore $SNAPSHOT_ID → $RESTORED_ID ──"
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$RESTORED_ID" \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --db-instance-class db.t3.small \
  --no-publicly-accessible \
  --region "$REGION" >/dev/null
aws rds wait db-instance-available \
  --db-instance-identifier "$RESTORED_ID" \
  --region "$REGION"

ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "$RESTORED_ID" \
  --region "$REGION" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
echo "Restored at $ENDPOINT"

echo
echo "── Step 3: trial balance verify ──"
DB_PASSWORD=$(aws ssm get-parameter \
  --name "/${APP_NAME}/DATABASE_PASSWORD" \
  --with-decryption --region "$REGION" \
  --query Parameter.Value --output text)

# Run a SQL trial balance directly — no need to spin the API up against the
# restored instance. Sum debits / credits across the journal_lines table.
DIFF=$(PGPASSWORD="$DB_PASSWORD" psql -h "$ENDPOINT" -U servd -d servd -t -A <<'SQL'
SELECT COALESCE(SUM(CASE WHEN type='debit'  THEN "amountCents" ELSE 0 END), 0)
     - COALESCE(SUM(CASE WHEN type='credit' THEN "amountCents" ELSE 0 END), 0)
  FROM journal_lines;
SQL
)

echo "Trial balance difference (debits − credits) on restored DB: $DIFF cents"

if [ "$DIFF" = "0" ]; then
  echo "✓ DRILL PASS — backup is restorable and ledger ties to zero."
  exit 0
else
  echo "✗ DRILL FAIL — restored ledger is unbalanced by $DIFF cents."
  echo "  Investigate before relying on backups."
  exit 2
fi
