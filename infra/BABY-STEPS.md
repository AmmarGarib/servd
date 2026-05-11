# 👶 servd go-live — baby steps (100% on AWS)

I did everything I could from my end. **You have ~5 clicky things to do.** Each step says exactly what page to be on, what to click, what to type.

When you finish a step, paste me what it asked for and I do the rest.

---

## ✅ Already done (don't worry about these)

- All Vercel projects deleted — we're 100% on AWS
- One EC2 box will run **everything**: backend + admin + storefront + Redis + TLS
- JWT secrets generated and baked into `infra/.env.production`
- Tarball ready: `c:\Dev\servd-deploy.tgz` (2 MB)

## What the final architecture looks like

```
                  Customer's phone/laptop
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
  admin.servd.pk    app.servd.pk      api.servd.pk
        │                 │                 │
        └─────────┬───────┴─────────────────┘
                  ▼
           ONE AWS EC2 box
        (running 5 Docker containers:
         api, admin, storefront, redis, caddy)
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   Neon Postgres      Cloudflare R2
   (database, free)   (file storage, free)
```

---

## STEP 1 — Cloudflare R2 (file storage). 5 min.

> Why: this is where uploaded photos go. 10 GB free forever, no egress fees.

1. Go to **https://dash.cloudflare.com**. Sign in (or sign up — free).
2. Left sidebar → click **R2 Object Storage**.
3. If first time: it'll say "Purchase R2." Click it. Free under 10 GB but a card is required. Add card.
4. Click the orange **Create bucket** button.
   - **Bucket name**: `servd-media`
   - **Location**: `Asia-Pacific (APAC)`
   - Click **Create bucket**.
5. You're now inside the bucket. Top tabs → click **Settings**.
6. Find **Public Access** → **R2.dev subdomain** row → click **Allow Access**. Confirm.
7. **Copy the URL** it shows you (looks like `https://pub-xxxxxxx.r2.dev`).
8. Back to R2 home (left sidebar → R2).
9. Right side → **Manage R2 API Tokens** → **Create API token**.
   - **Token name**: `servd-prod`
   - **Permissions**: **Object Read & Write**
   - **Specify bucket**: **Apply to specific buckets only** → pick `servd-media`
   - **TTL**: Forever
   - **Create API Token**.
10. Copy these THREE values shown ONCE:
    - **Access Key ID**
    - **Secret Access Key**
    - **Account ID** (shown at top of any R2 page)

> 📋 **Paste me 4 things**: public URL from #7, Account ID, Access Key ID, Secret Access Key.

---

## STEP 2 — Resend (email). 2 min.

> Why: receipts, magic-link login. 3000 emails/month free.

1. Go to **https://resend.com** → **Sign up**.
2. Verify email.
3. Dashboard → left sidebar → **API Keys** → **Create API Key**.
   - **Name**: `servd-prod`
   - **Permission**: Full access
   - **Add**.
4. Copy the `re_...` key shown ONCE.

> 📋 **Paste me**: that one `re_...` key.

---

## STEP 3 — AWS EC2 box. 10 min.

### 3a. Launch the instance

1. Go to **https://console.aws.amazon.com**. Sign in.
2. Top-right region selector → **Asia Pacific (Singapore) ap-southeast-1** (closest to Pakistan + matches Neon DB).
3. Top search bar → `EC2` → click **EC2**.
4. Big orange **Launch instance** button.
5. Fill in:
   - **Name**: `servd-prod`
   - **Quick Start** → **Ubuntu** → version **Ubuntu Server 22.04 LTS (HVM) (Free tier eligible)**
   - **Instance type** → **t3.micro** (Free tier eligible — verify it says that)
   - **Key pair (login)** → **Create new key pair**
     - Name: `servd-prod`
     - Type: **RSA**
     - Format: **`.pem`**
     - **Create key pair** → file downloads. **SAVE IT FOREVER.**
   - **Network settings** → **Edit**:
     - **Security group name**: `servd-prod-sg`
     - Inbound rules (use **Add security group rule** for #2 and #3):
       1. **SSH** | TCP | 22 | source: **My IP**
       2. **HTTP** | TCP | 80 | source: **Anywhere** (`0.0.0.0/0`)
       3. **HTTPS** | TCP | 443 | source: **Anywhere** (`0.0.0.0/0`)
   - **Configure storage** → change `8` to **`30`** GiB (still free tier)
   - **Advanced details** (collapsed at bottom — click to expand) → scroll way down to **User data** field → paste this **entire** block:

```bash
#!/bin/bash
set -euxo pipefail
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git unattended-upgrades
usermod -aG docker ubuntu
echo 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/20auto-upgrades
echo 'APT::Periodic::Unattended-Upgrade "1";' >> /etc/apt/apt.conf.d/20auto-upgrades
mkdir -p /opt/servd
chown ubuntu:ubuntu /opt/servd
# Add 1GB swap (helps t3.micro 1GB RAM survive memory spikes)
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

6. Right side → **Launch instance**.
7. **View all instances** → wait ~3 min for **Status check: 2/2 checks passed** (green).

### 3b. Make the IP permanent (Elastic IP)

1. EC2 left sidebar → **Elastic IPs** (under "Network & Security")
2. **Allocate Elastic IP address** → leave defaults → **Allocate**
3. Select the new IP row → **Actions** → **Associate Elastic IP address**
   - **Resource type**: Instance
   - **Instance**: `servd-prod`
   - **Associate**
4. **Copy the Elastic IP** (looks like `13.250.123.45`).

> 📋 **Paste me**: the Elastic IP, AND the path to your `servd-prod.pem` file (probably `c:\Users\agari\Downloads\servd-prod.pem`).

---

## STEP 4 — Domain (servd.pk). 2 min.

> Why: gives `https://api.servd.pk`, `admin.servd.pk`, `app.servd.pk` real TLS certs.

This assumes `servd.pk` is yours, managed in Cloudflare. If not — tell me, there's a no-domain workaround (Cloudflare Tunnel).

1. Cloudflare → click `servd.pk` → **DNS** → **Records**.
2. Add **3 records**, all the same except the Name:

| Type | Name | IPv4 address | Proxy status | TTL |
|---|---|---|---|---|
| A | `api` | `<your Elastic IP>` | **DNS only** (grey cloud) | Auto |
| A | `admin` | `<your Elastic IP>` | **DNS only** (grey cloud) | Auto |
| A | `app` | `<your Elastic IP>` | **DNS only** (grey cloud) | Auto |

> ⚠️ **DNS only, NOT Proxied (grey, not orange).** Caddy issues TLS itself; if Cloudflare proxies, the Let's Encrypt cert challenge fails.

> 📋 **Paste me**: just say "DNS done."

---

## STEP 5 — I do the rest

Once you've pasted me:
1. The 4 R2 values
2. The Resend `re_...` key
3. The Elastic IP and PEM file path
4. "DNS done"

…I will:
- Splice all the secrets into `.env.production`
- Rebuild the tarball
- Walk you through 2 PowerShell commands to upload + SSH in
- Run `docker compose up -d --build` for you (you paste my commands as I tell you)
- Verify all 3 subdomains respond:
  - https://api.servd.pk/health
  - https://admin.servd.pk
  - https://app.servd.pk
- We watch the live site come up together

---

## Total time

- You: ~20 min of clicking through 3 web consoles
- Me: ~3 min of stitching it together
- Plus: ~5 min for the EC2 to build all 3 Docker images on first boot
- **Net: live in ~30 min**

## Cost after this

- EC2 t3.micro: **$0/month for 12 months** (free tier — 750 hr/mo). Then ~$7.50/mo.
- Elastic IP: $0 while attached to a running instance.
- Storage: $0 (30 GB is the free tier ceiling — we take all of it).
- Egress: $0 up to 100 GB/month outbound (free tier). Beyond, $0.09/GB.
- Neon: $0 (free 0.5 GB tier).
- Cloudflare R2: $0 (free 10 GB tier, no egress fees).
- Resend: $0 (free 3k/mo).
- **Total monthly: $0** for the first 12 months at low traffic.
