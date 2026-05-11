#!/bin/bash
# servd one-paste boot — run this AFTER you've SCP'd the tarball up.
# It extracts the code, builds the containers, brings them up.
# If anything fails, scroll up — the offending line ends with `exit 1`.

set -euxo pipefail

# ─── 1. Extract the uploaded tarball into /opt/servd ─────────────────────────
sudo mkdir -p /opt/servd
sudo chown -R ubuntu:ubuntu /opt/servd
tar -xzf /tmp/servd-deploy.tgz -C /opt --strip-components=0
sudo chown -R ubuntu:ubuntu /opt/servd

# ─── 2. Bring the stack up ──────────────────────────────────────────────────
cd /opt/servd/infra
docker compose pull --ignore-pull-failures || true   # base images
docker compose up -d --build

# ─── 3. Show status ─────────────────────────────────────────────────────────
sleep 4
docker compose ps
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Stack is up. Watch the API boot with:"
echo "    docker compose logs -f api"
echo ""
echo "  Once you see 'Server listening', test from your laptop:"
echo "    curl https://api.servd.pk/health"
echo "════════════════════════════════════════════════════════════════"
