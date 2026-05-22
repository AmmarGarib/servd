# servd — Running via Docker on a Fresh Windows Machine

This is for someone who wants to **run** servd without building from source.
They pull prebuilt images from a private Docker Hub repo and start the stack.

---

## What you need

- **Windows 10/11** with virtualization enabled in BIOS (most modern PCs)
- **Docker Desktop** installed — https://www.docker.com/products/docker-desktop/
- **Docker Hub credentials** for the account that owns the private servd repos
- About **2 GB** disk space for the three images

---

## One-time setup

1. **Install Docker Desktop**, launch it, accept the WSL2 prompt if it appears, wait
   for the whale icon in the tray to go solid (not animating).

2. **Clone or copy this folder** to anywhere on the machine, e.g. `C:\servd-run`.
   You only need these files — the rest of the repo isn't required for running:
   ```
   docker-compose.yml
   .env.docker.template
   DOCKER-HANDOFF.md
   ```

3. **Create your `.env` file** from the template:
   ```powershell
   Copy-Item .env.docker.template .env
   notepad .env
   ```
   Fill in:
   - `DOCKER_USER` — Docker Hub username/org hosting the images (ask the owner)
   - `DATABASE_URL` — Supabase Postgres connection string
   - `REDIS_URL` — Upstash Redis URL
   - `JWT_SECRET`, `JWT_REFRESH_SECRET` — any 32+ char random strings
   - Anything else relevant to your usage

4. **Log into Docker Hub** so you can pull the private images:
   ```powershell
   docker login
   ```
   Enter the Docker Hub username + a Personal Access Token (not your password —
   create one at https://hub.docker.com/settings/security).

---

## Run it

```powershell
docker compose pull       # downloads the 3 images, ~10 min on first run
docker compose up -d      # boots everything in the background
docker compose ps         # shows status
docker compose logs -f    # tails logs (Ctrl-C to stop tailing — services keep running)
```

Then open in a browser:

- **Admin / operator UI** → http://localhost:3000
- **Storefront** → http://localhost:3002
- **API** (health) → http://localhost:3001/health

To stop:
```powershell
docker compose down       # stops & removes containers (keeps your .env + images)
```

To update after a new image push from the maintainer:
```powershell
docker compose pull
docker compose up -d
```

---

## Troubleshooting

**`docker compose pull` says "denied: requested access to the resource is denied"**
You're not logged in, or the account doesn't have access to the private repo.
Run `docker login` again, or ask the owner to add your Docker Hub account as a
collaborator on the repos.

**`docker compose ps` shows containers as "unhealthy" or exiting**
Check logs: `docker compose logs api` (or `admin` / `storefront`).
Most common cause: `DATABASE_URL` or `REDIS_URL` is wrong in `.env`.

**Admin UI loads but API calls fail with CORS/network errors**
The images bake `NEXT_PUBLIC_API_URL=http://localhost:3001` at build time. If
you need a different host, the maintainer must rebuild the admin + storefront
images with the right build args.

**Docker Desktop says "WSL needs updating"**
Run `wsl --install --no-distribution` from an **admin** PowerShell, reboot.

---

## For the maintainer — publishing new images

The 3 services all live under **one** private Docker Hub repo (`ammargarib/servd`)
with 3 tags (`api`, `admin`, `storefront`), since the free tier gives 1 private repo.

From the full source repo:
```powershell
cd c:\Dev\servd
docker login
.\scripts\docker-publish.ps1
# with a version suffix (also pushes :api-v1.0.0 etc.):
.\scripts\docker-publish.ps1 -Version v1.0.0
# different repo:
.\scripts\docker-publish.ps1 -Repo otheruser/servd
```
