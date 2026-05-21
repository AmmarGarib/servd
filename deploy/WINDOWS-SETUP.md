# Servd — Windows Docker + Cloudflare Tunnel Setup Guide

Everything runs in Docker Desktop on your Windows machine. Cloudflare Tunnel
punches a secure HTTPS hole to the internet without you needing to open ports
or configure a router. No Nginx, no Caddy, no certificates to manage.

---

## What you get

```
Internet (HTTPS)
     │
     ▼
Cloudflare Tunnel  (cloudflared container, auto TLS)
     │
     ├── api.garibsons.app    → api container  (Fastify, port 3001)
     ├── admin.garibsons.app  → admin container (Next.js admin panel)
     ├── app.garibsons.app    → storefront container (Next.js customer app)
     └── deploy.garibsons.app → webhook server  (auto-redeploy from GitHub)

Windows Docker Desktop
  ├── postgres  (local database)
  ├── redis     (job queue + socket adapter)
  ├── api
  ├── admin
  ├── storefront
  └── cloudflared

Windows host (outside Docker)
  └── webhook-server.js  (started by start-webhook.bat)
```

---

## Prerequisites — install these first

| Tool | Where to get it | Check |
|------|-----------------|-------|
| Docker Desktop | https://www.docker.com/products/docker-desktop/ | `docker --version` |
| Git for Windows | https://git-scm.com/download/win | `git --version` |
| Node.js 20+ | https://nodejs.org/ | `node --version` |

After installing Docker Desktop: open it, wait for the whale icon to stop
animating, then verify with `docker info` in PowerShell (no errors = ready).

---

## Step 1 — Clone the repo (if not done)

```powershell
git clone <YOUR_GITHUB_REPO_URL> C:\servd
cd C:\servd
```

---

## Step 2 — Create your env files

You need two files inside the `deploy\` folder. These are never committed to git.

### 2a — deploy\.env  (build args + Cloudflare token)

```powershell
copy deploy\.env.example deploy\.env
notepad deploy\.env
```

Fill in:

| Variable | What to put |
|----------|-------------|
| `DB_PASSWORD` | Any strong password, e.g. `Str0ng!Pass#2024` |
| `PUBLIC_API_URL` | `https://api.garibsons.app` — your real domain |
| `PUBLIC_WS_URL` | Same as `PUBLIC_API_URL` |
| `CF_TUNNEL_TOKEN` | Get this in Step 3 |
| `WEBHOOK_SECRET` | Any random string — keep it secret. Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

### 2b — deploy\.env.production  (backend runtime secrets)

```powershell
copy deploy\.env.production.example deploy\.env.production
notepad deploy\.env.production
```

Minimum required fields (others are optional):

| Variable | How to get it |
|----------|---------------|
| `JWT_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `JWT_REFRESH_SECRET` | Generate another one the same way |
| `API_URL` | `https://api.garibsons.app` |
| `WEB_URL` | `https://admin.garibsons.app` |
| `STOREFRONT_URL` | `https://app.garibsons.app` |

Payment/SMS/email fields can be left blank initially — those features just
won't work until you fill them in. The server starts fine without them.

---

## Step 3 — Create a Cloudflare Tunnel

You need a free Cloudflare account and your domain on Cloudflare.

1. Go to **https://dash.cloudflare.com** → sign in.
2. Left sidebar → **Zero Trust** → **Networks** → **Tunnels**.
3. Click **Create a tunnel** → **Cloudflared** → give it a name (e.g. `servd-prod`).
4. On the "Install connector" screen, copy the **token** from the
   `cloudflared service install <TOKEN>` command. It looks like a long base64 string.
5. Paste this token as `CF_TUNNEL_TOKEN` in `deploy\.env`.
6. Click **Next** — you'll configure the routes in the next step.

### 3a — Configure public hostnames (routes)

In the tunnel configuration, add these routes one by one:

| Subdomain | Domain | Service type | URL |
|-----------|--------|--------------|-----|
| `api` | `garibsons.app` | HTTP | `api:3001` |
| `admin` | `garibsons.app` | HTTP | `admin:3000` |
| `app` | `garibsons.app` | HTTP | `storefront:3000` |
| `deploy` | `garibsons.app` | HTTP | `host.docker.internal:9000` |

> The `deploy` route uses `host.docker.internal` because the webhook server
> runs on the Windows host (outside Docker), not in a container.

Click **Save tunnel**.

---

## Step 4 — First deploy

Double-click **`deploy.bat`** in the project root.

What it does:
1. Runs `git pull` to get the latest code
2. Runs `docker compose up -d --build` (builds all images and starts containers)
3. Shows container status

**First run takes 5–10 minutes** because it builds three Node.js apps from
scratch. Subsequent runs are much faster (Docker layer cache).

Watch the API start up:
```powershell
cd deploy
docker compose logs -f api
```
You should see:
```
prisma migrate deploy ... applied N migrations
Server listening at http://0.0.0.0:3001
```

### Verify everything is working

```powershell
# API health (once CF tunnel is up)
curl https://api.garibsons.app/health

# Or locally (API port is not exposed by default, but you can test directly)
docker compose -f deploy\docker-compose.yml exec api wget -qO- http://localhost:3001/health
```

---

## Step 5 — Start the auto-deploy webhook

Double-click **`start-webhook.bat`** in the project root and keep that window open.

This starts a small HTTP server on port 9000. When you hit the deploy URL,
it runs `git pull` + `docker compose up --build` automatically.

**Your deploy URL:**
```
POST https://deploy.garibsons.app/deploy?secret=<your_WEBHOOK_SECRET>
```

Test it from PowerShell:
```powershell
$secret = "your_WEBHOOK_SECRET_here"
Invoke-RestMethod -Method POST "http://localhost:9000/deploy?secret=$secret"
```

Check deployment status:
```powershell
Invoke-RestMethod "http://localhost:9000/health"
```

### Auto-start webhook on Windows boot (optional)

To have the webhook start automatically when Windows boots:

1. Press **Win + R** → type `shell:startup` → Enter
2. Create a shortcut to `start-webhook.bat` in that folder

---

## Daily operations

All commands should be run from a PowerShell window in the project root.

```powershell
# View all logs live
cd deploy && docker compose logs -f

# View only API logs
cd deploy && docker compose logs -f api

# Restart just the API (fast — no rebuild)
cd deploy && docker compose restart api

# Stop everything
cd deploy && docker compose down

# Full redeploy (same as deploy.bat)
git pull
cd deploy && docker compose up -d --build

# Open database studio (browser UI for Postgres)
cd deploy && docker compose exec api npx prisma studio
```

---

## Updating the domain/URL

If you change your domain or public URL:

1. Update `PUBLIC_API_URL` and `PUBLIC_WS_URL` in `deploy\.env`
2. Update `API_URL`, `WEB_URL`, `STOREFRONT_URL` in `deploy\.env.production`
3. Update the routes in the Cloudflare Tunnel dashboard
4. Run a full rebuild: `double-click deploy.bat`
   (The Next.js apps bake the URL into the JS bundle — rebuild is required)

---

## Troubleshooting

**Containers crash immediately after starting**
```powershell
cd deploy && docker compose logs api
```
Most common cause: `JWT_SECRET` is missing or too short (must be 32+ chars).

**Cloudflare Tunnel shows "Bad Gateway"**
- Verify the service names match (`api:3001`, `admin:3000`, `storefront:3000`)
- Check containers are running: `docker compose ps`
- Service names in tunnel config are case-sensitive and must match exactly

**`deploy.bat` fails at git pull**
- If this is the first deploy, ignore it — there's nothing to pull yet
- If repo is private: make sure git has your credentials stored
  (`git config --global credential.helper manager`)

**Next.js shows wrong API URL**
- The `NEXT_PUBLIC_API_URL` is baked into the image at build time
- You must rebuild after changing it: `docker compose up -d --build admin storefront`

**Webhook returns 403 Forbidden**
- Check `WEBHOOK_SECRET` in `deploy\.env` matches what you're sending
- Query param: `?secret=yourvalue`
- Or header: `X-Deploy-Secret: yourvalue`

**Out of disk space (Windows)**
- Clean old Docker images: `docker image prune -f`
- Clean everything unused: `docker system prune -f`

---

## Cost

Running locally on your own Windows machine: **$0**.
Cloudflare Tunnel (Zero Trust): **Free for personal/small use**.
Cloudflare R2 storage (for media uploads): **Free up to 10 GB**.
