#!/bin/bash
# servd EC2 bootstrap — run once on a fresh Ubuntu 22.04 t3.micro.
# Paste this into the "User data" field when launching the instance,
# OR scp it up and run as root.
#
# What it does:
#   1. Installs Docker + compose plugin
#   2. Installs git
#   3. Creates an `ubuntu` user-owned /opt/servd checkout
#   4. Leaves you to: clone the repo, drop in .env.production, then `docker compose up -d`

set -euxo pipefail

# ─── Ubuntu hardening ────────────────────────────────────────────────────────
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

# ─── Docker (official repo, not the snap) ────────────────────────────────────
apt-get install -y ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  git \
  unattended-upgrades

# ─── Allow ubuntu user to run docker without sudo ────────────────────────────
usermod -aG docker ubuntu

# ─── Auto security upgrades ──────────────────────────────────────────────────
echo 'APT::Periodic::Update-Package-Lists "1";' \
  > /etc/apt/apt.conf.d/20auto-upgrades
echo 'APT::Periodic::Unattended-Upgrade "1";' \
  >> /etc/apt/apt.conf.d/20auto-upgrades

# ─── Make a place for the app ────────────────────────────────────────────────
mkdir -p /opt/servd
chown ubuntu:ubuntu /opt/servd

# ─── Helpful login banner so future-you knows what to do ─────────────────────
cat > /etc/motd <<'MOTD'

  ╔═══════════════════════════════════════════════════════════════════╗
  ║                  servd production box                             ║
  ╠═══════════════════════════════════════════════════════════════════╣
  ║                                                                   ║
  ║  First-time setup (after cloning the repo to /opt/servd):         ║
  ║                                                                   ║
  ║    cd /opt/servd/infra                                            ║
  ║    cp .env.production.example .env.production                     ║
  ║    nano .env.production    # fill in JWT secrets, R2 keys, etc.   ║
  ║    nano Caddyfile          # set your real domain                 ║
  ║    docker compose up -d --build                                   ║
  ║    docker compose logs -f api                                     ║
  ║                                                                   ║
  ║  Update:    cd /opt/servd && git pull && cd infra                 ║
  ║             && docker compose up -d --build api                   ║
  ║                                                                   ║
  ║  Restart:   cd /opt/servd/infra && docker compose restart api     ║
  ║                                                                   ║
  ╚═══════════════════════════════════════════════════════════════════╝

MOTD

echo "Bootstrap complete. Reboot recommended so the docker group takes effect."
