# servd deployment runbook

Get from zero to production on the cheapest possible footprint:

| Layer | Where | Cost |
|---|---|---|
| Frontends (admin + storefront) | **Vercel** | Free Hobby |
| Backend (Fastify + Socket.IO + workers) | **AWS EC2 t3.micro** | Free 12 months |
| Postgres | **Neon** (already wired) | Free 0.5 GB |
| Redis | **Self-hosted on EC2** (Docker) | Free, no quota |
| Media uploads | **Cloudflare R2** | Free 10 GB, $0 egress |
| TLS | **Let's Encrypt via Caddy** | Free |
| Email | **Resend** | Free 3k/mo |

The Vercel frontends are already deployed (see "Status" below). What follows is everything needed to bring up the backend.

---

## Status — what's already done

- [x] `servd-storefront` linked + deployed → https://servd-storefront.vercel.app
- [x] `servd-admin` linked + deployed → https://servd-admin.vercel.app
- [x] tsconfigs flattened so Vercel monorepo deploys work
- [x] Backend Dockerfile, docker-compose, Caddyfile, .env template authored

## What you need to do (one-time, ~30 min)

1. **AWS account** — sign in at console.aws.amazon.com (you'll need a card on file even for the free tier).
2. **Cloudflare account** — sign up at dash.cloudflare.com (free).
3. **A domain** — `servd.pk` or any registrar. Points DNS at Cloudflare nameservers.
4. **Resend account** — sign up at resend.com → API key for SMTP.

---

## Step 1 — Cloudflare R2 bucket

1. Cloudflare dashboard → **R2 Object Storage** → click "Purchase R2" (it's free under 10 GB; card required to enable).
2. **Create bucket** → name: `servd-media` → location: Asia-Pacific.
3. Bucket → **Settings** → **Public access** → enable **Custom Domain** later (optional). For now, click "Allow Access" on the `r2.dev` subdomain — copy that URL, you'll paste it as `R2_PUBLIC_URL`.
4. R2 dashboard → **Manage R2 API Tokens** → **Create API token**:
   - Permissions: **Object Read & Write**
   - Bucket: `servd-media` only
   - TTL: forever
5. **Copy these three values now — they're shown ONCE**:
   - Account ID
   - Access Key ID
   - Secret Access Key
6. Test from your laptop:
   ```bash
   aws s3 ls s3://servd-media \
     --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
     --profile r2
   ```
   (after `aws configure --profile r2` with the keys, region `auto`)

---

## Step 2 — Launch the EC2 instance

1. AWS Console → **EC2** → **Launch instance**.
2. Settings:
   - **Name**: `servd-prod`
   - **AMI**: Ubuntu Server 22.04 LTS (free tier eligible)
   - **Instance type**: `t3.micro` (free tier — 750 hr/month for 12 months)
   - **Key pair**: create new → name `servd-prod` → download the `.pem` (save it somewhere safe; you'll need it forever)
   - **Network settings** → **Edit** → Security group:
     - Allow SSH (22) from **My IP**
     - Allow HTTP (80) from **Anywhere**
     - Allow HTTPS (443) from **Anywhere**
   - **Storage**: 30 GB gp3 (free tier ceiling is 30 GB — take it all)
   - **Advanced** → **User data** → paste the entire contents of `infra/ec2-bootstrap.sh`
3. **Launch instance**. Wait ~3 min for status checks to go green.
4. Note the **Public IPv4 address** (e.g. `54.66.123.45`).

### Allocate an Elastic IP (so the public IP doesn't change on reboot)

1. EC2 → **Elastic IPs** → **Allocate** → default settings → **Allocate**.
2. Right-click the new EIP → **Associate** → select the `servd-prod` instance.
3. Re-note the IP — this is your permanent public IP.

---

## Step 3 — Point DNS at the box

In Cloudflare → your domain → **DNS** → **Add record**:

| Type | Name | Content | Proxy status | TTL |
|---|---|---|---|---|
| A | `api` | `<elastic IP>` | DNS only (grey cloud) | Auto |

> ⚠️ **DNS only, not Proxied.** Caddy handles TLS itself; if Cloudflare proxies, the Let's Encrypt challenge fails.

Verify: `dig +short api.servd.pk` should print your EIP within a minute.

---

## Step 4 — SSH in + clone the repo

From your laptop (PowerShell):
```powershell
chmod 400 .\servd-prod.pem    # only needed if it complains about perms
ssh -i .\servd-prod.pem ubuntu@<elastic-ip>
```

> If you see "user-data still running", wait 1–2 min and retry — the bootstrap script needs to finish.

Once in:
```bash
# Reboot once so the `docker` group membership applies to your shell
sudo reboot
# (reconnect after ~30s)

# Clone the repo
cd /opt/servd
git clone <YOUR_GIT_REMOTE> .
# OR if you don't have a git remote yet, scp the project up:
#   exit
#   scp -i ./servd-prod.pem -r c:/Dev/servd/* ubuntu@<eip>:/opt/servd/
```

> Don't have git set up yet? You can use `scp -r` to push the local folder up. Don't push `node_modules` or `.next` — wastes time. From PowerShell:
> ```powershell
> tar -czf servd.tgz --exclude='node_modules' --exclude='.next' --exclude='.turbo' --exclude='dist' -C c:/Dev servd
> scp -i .\servd-prod.pem .\servd.tgz ubuntu@<eip>:/tmp/
> ssh -i .\servd-prod.pem ubuntu@<eip> 'cd /opt && sudo tar -xzf /tmp/servd.tgz && sudo chown -R ubuntu:ubuntu /opt/servd'
> ```

---

## Step 5 — Configure environment

```bash
cd /opt/servd/infra

# Copy the template
cp .env.production.example .env.production

# Generate fresh JWT secrets (don't reuse dev ones)
openssl rand -base64 48
openssl rand -base64 48
# Paste these into JWT_SECRET and JWT_REFRESH_SECRET

nano .env.production
# Fill in:
#   - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (from Step 1)
#   - R2_PUBLIC_URL (the r2.dev URL or your custom domain)
#   - SMTP_PASS (Resend API key)
#   - WEB_URL, STOREFRONT_URL — already point at the Vercel deploys, keep as-is
#   - API_URL = https://api.servd.pk

# Update the Caddyfile to your real domain (default placeholder is api.servd.pk)
nano Caddyfile
# Change `api.servd.pk` if different
```

---

## Step 6 — Boot it up

```bash
cd /opt/servd/infra
docker compose up -d --build

# Watch the API come online — first boot runs prisma migrate deploy
docker compose logs -f api
```

You should see:
```
prisma migrate deploy ... applied N migrations
Server listening at http://0.0.0.0:3001
```

Then in another terminal:
```bash
# Caddy should already have a Let's Encrypt cert
curl -I https://api.servd.pk/health
# HTTP/2 200
```

---

## Step 7 — Wire frontends to the live API

Set Vercel env vars (one-time):

```powershell
# From c:\Dev\servd\frontend\admin
cd c:\Dev\servd\frontend\admin
vercel env add NEXT_PUBLIC_API_URL production
# Paste: https://api.servd.pk
vercel env add NEXT_PUBLIC_WS_URL production
# Paste: https://api.servd.pk
vercel deploy --prod --yes

# Same for storefront
cd c:\Dev\servd\frontend\storefront
vercel env add NEXT_PUBLIC_API_URL production
# Paste: https://api.servd.pk
vercel env add NEXT_PUBLIC_WS_URL production
# Paste: https://api.servd.pk
vercel deploy --prod --yes
```

(Or use the Vercel dashboard → project → Settings → Environment Variables.)

---

## Updates & operations

```bash
# Deploy a new code version
cd /opt/servd && git pull
cd infra && docker compose up -d --build api

# View logs
docker compose logs -f api

# Restart just the API (keeps Redis state)
docker compose restart api

# Open a Prisma shell
docker compose exec api npx prisma studio

# Snapshot Redis (manual)
docker compose exec redis redis-cli BGSAVE

# Disk usage
df -h
docker system df
```

## Cost watch

- EC2 t3.micro free tier: **750 hours/month for 12 months** — that's one box running 24/7. After year 1, ~$7.50/mo (or move to Lightsail $3.50/mo, same hardware).
- Elastic IP: free **as long as it's attached** to a running instance. If the instance is stopped, AWS bills $0.005/hr for the unused EIP.
- Egress: AWS gives 100 GB/month free outbound. Beyond that, $0.09/GB. R2 has $0 egress, which is why media goes there, not S3.
- Neon free: 0.5 GB storage, 191.9 compute hours/month. The DB sleeps when idle, so cold starts add ~500 ms to the first request after a quiet period. Acceptable for early traffic.

## When to upgrade off free tier

| Signal | Move to |
|---|---|
| EC2 CPU credits exhausted (sustained > 10% CPU) | t3.small ($15/mo) — 2 GB RAM |
| Neon hits 0.5 GB | Neon Pro $19/mo, or migrate to Supabase |
| R2 hits 10 GB | R2 paid tier — $0.015/GB still no egress |
| Resend hits 3k/mo | Resend $20/mo for 50k |
| One EC2 box can't keep up | Add a second worker box with the same compose file but `ENABLE_WORKERS=true` and the api one set to `false` |

---

## Troubleshooting

**Caddy can't get a cert**
- DNS not propagated yet → `dig +short api.servd.pk` should print your EIP
- Cloudflare DNS is **Proxied** (orange cloud) — set it to **DNS only** (grey cloud)
- Port 80 not open in security group → re-check EC2 security group inbound rules

**Backend crashes on first start**
- `docker compose logs api` will show prisma errors if `DATABASE_URL` is wrong
- Test connectivity: `docker compose exec api npx prisma db pull` (read-only — confirms DB reach)

**Workers logging "out of limit"**
- That's the Upstash quota (which we replaced). If you still see it, the env still points at Upstash. Confirm `REDIS_URL` inside the container:
  ```bash
  docker compose exec api printenv REDIS_URL
  # should print: redis://redis:6379
  ```

**Vercel deployment can't reach api.servd.pk**
- It's a CORS issue if browser logs say so → verify `WEB_URL` and `STOREFRONT_URL` in `.env.production` match the actual Vercel URLs exactly (no trailing slash)
- It's a network issue if `curl` from the EC2 box also fails → port 443 not open to the internet
