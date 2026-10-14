# servd practice copy: setup and running it

The practice copy is a second, separate servd where staff can try anything:
ring up orders, void, refund, change menus, run payroll, close a month. None of
it touches the live ERP.

| | Live ERP | Practice copy |
|---|---|---|
| Admin | https://admin.servd.pk | **https://sandbox.servd.pk** |
| API | https://api.servd.pk | **https://sandbox-api.servd.pk** |
| Database | Neon, production branch | Neon, its own branch `practice`: a copy of the real data on the day you make it |
| Redis | Upstash | Its own container (`sandbox-redis`) |
| Secrets | Live keys | New keys made only for the practice copy |
| Cloudflare tunnel | the live tunnel | Its own tunnel, `servd-practice` |
| Folder on the box | `C:\servd\deploy` | `C:\servd-sandbox` (Docker project `servd-sandbox`) |

The two copies share nothing. After you make the copy, live changes don't show
up in it and practice changes never go back to live. Every page of the
practice copy has an orange **PRACTICE COPY** stripe at the top, and every tab
title starts with **[PRACTICE]**.

**It holds real personal data.** The copy includes real customers' names,
phone numbers, emails and addresses, plus staff records and sales. That is why
it can never send anything out (see step 7) and why access must be limited
(also step 7).

Before you start you need:
- access to the Neon console (the servd project) and to Cloudflare Zero Trust
  (the servd.pk account);
- the Windows box with Docker Desktop. The live box is fine because the
  practice copy is a separate project with its own limits;
- the two practice images pushed to Docker Hub (`ammargarib/servd:api-sandbox`
  and `ammargarib/servd:admin-sandbox`). IT does this; see "For IT" at the end.

---

## 1. Make the database copy (Neon branch)

1. Open https://console.neon.tech and open the **servd** project.
2. Go to **Branches**, then **Create branch** (or **New branch**).
3. Name it `practice`. For the parent, pick the branch live servd uses (the
   production branch, usually `main` or `production`). For the starting point,
   pick **current data** (today). Click **Create**.
4. On the new branch, click **Connect**. Choose branch `practice`, the same
   database and role that live uses, and **turn connection pooling OFF**. Copy
   the connection string. It starts with `postgresql://` and ends with
   `?sslmode=require`. This is your `DATABASE_URL`.
5. Check it: the address after `@` starts with `ep-…` and must be **different**
   from the address in live's `DATABASE_URL`, because every Neon branch gets its
   own address. If the two are the same, you copied the live one. Stop and
   copy the practice one.
6. Recommended: give the copy its own password. Open the branch's **Roles &
   Databases** page, find the role, choose **Reset password**, and copy the
   connection string again. Otherwise the copy keeps live's database password,
   and after the reset the practice password opens only the practice copy.
   The reset changes the practice branch only.

Cost: the branch stores only what changes in it, and its compute can sleep when
nobody uses it. Set its compute to the smallest size with scale-to-zero on.

## 2. Make the Cloudflare tunnel (separate from live)

1. Open https://one.dash.cloudflare.com, then go to **Networks** → **Tunnels**
   → **Create a tunnel** → **Cloudflared**.
2. Name it `servd-practice` and save.
3. On the "Install connector" screen, copy the **token**: the long string after
   `--token` or `service install`. This is your `CF_TUNNEL_TOKEN`.
   **Don't** run the install command on the box, because Docker runs the
   connector.
4. Copy the tunnel's **ID** (the UUID shown for `servd-practice` in the tunnel
   list). This is your `CF_TUNNEL_ID`. Before it connects, the practice stack
   checks that the token belongs to this tunnel. If someone pastes the live
   tunnel's token by mistake, it refuses to start instead of taking a share of
   live traffic.
5. Add two **public hostnames** (Cloudflare also calls them "published
   application routes"):

   | Subdomain | Domain | Type | URL |
   |---|---|---|---|
   | `sandbox` | `servd.pk` | HTTP | `sandbox-admin:3000` |
   | `sandbox-api` | `servd.pk` | HTTP | `sandbox-api:3001` |

   These names are one level under servd.pk, so Cloudflare's free certificate
   covers them. That is why the API is `sandbox-api`, not `api.sandbox`.
6. Never add a practice hostname to the live tunnel, and never add a live
   hostname to `servd-practice`.
7. Recommended second lock: go to **Access** → **Applications** → **Add an
   application** → **Self-hosted**. Set the hostname to **`sandbox.servd.pk`
   only**, with a policy that allows the email addresses of the people on the
   access list (step 7). Do **not** put `sandbox-api.servd.pk` behind Access,
   because the admin calls it from the browser and would stop working. The API
   still needs a servd login, exactly like live.

## 3. Start it on the box

1. Open PowerShell and make the practice folder. Keep it outside the live
   folder:

   ```powershell
   New-Item -ItemType Directory C:\servd-sandbox
   cd C:\servd-sandbox
   ```

2. Copy in three files from the repo's `deploy\sandbox\` folder:
   `docker-compose.yml`, `.env.example` and `update.bat`. If the repo is
   cloned at `C:\servd`:

   ```powershell
   Copy-Item C:\servd\deploy\sandbox\docker-compose.yml, C:\servd\deploy\sandbox\.env.example, C:\servd\deploy\sandbox\update.bat C:\servd-sandbox\
   Copy-Item .env.example .env
   ```

3. Make the new secrets. Paste this into PowerShell. It prints four ready-made
   lines, each with a fresh random value:

   ```powershell
   function New-Secret([int]$bytes) {
     $b = New-Object byte[] $bytes
     [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
     [Convert]::ToBase64String($b)
   }
   "JWT_SECRET=$(New-Secret 48)"
   "JWT_REFRESH_SECRET=$(New-Secret 48)"
   "SERVD_SECRET_KEY=$(New-Secret 32)"
   "KEENU_WEBHOOK_SECRET=$(New-Secret 32)"
   ```

   Never reuse a live value. With new values, a live sign-in doesn't work in
   the practice copy and a practice sign-in doesn't work on live. The live
   integration keys that came over with the data (POS connector, WhatsApp
   gateway, SMTP) also can't be unlocked in the practice copy.

4. Find the live hostnames for `SERVD_PROD_HOSTS`. They are in the live
   stack's env file, usually `C:\servd\deploy\.env.production`. The command
   below prints only the hostnames, never the passwords:

   ```powershell
   Get-Content C:\servd\deploy\.env.production |
     Where-Object { $_ -match '^(DATABASE_URL|REDIS_URL)=' } |
     ForEach-Object { ([uri](($_ -replace '^[A-Z_]+=','').Trim('"', "'"))).Host }
   ```

   Write them comma-separated. For the database, write both forms: the one
   with `-pooler` and the one without. For example:
   `ep-abc-123456.ap-southeast-1.aws.neon.tech,ep-abc-123456-pooler.ap-southeast-1.aws.neon.tech,abc-12345.upstash.io`.
   If `DATABASE_URL` or `REDIS_URL` ever points at one of these hosts, the
   practice API refuses to start.

5. Fill in `.env` (`notepad .env`):

   | Variable | What to put |
   |---|---|
   | `DATABASE_URL` | The practice branch's connection string from step 1 |
   | `JWT_SECRET`, `JWT_REFRESH_SECRET` | The two new values from item 3 |
   | `SERVD_SECRET_KEY` | The new 32-byte value from item 3 |
   | `KEENU_WEBHOOK_SECRET` | The new value from item 3 |
   | `SERVD_PROD_HOSTS` | The live hostnames from item 4 |
   | `REDIS_URL` | Leave it as `redis://sandbox-redis:6379` |
   | `CF_TUNNEL_TOKEN`, `CF_TUNNEL_ID` | From step 2 |

   Leave out every WhatsApp, SMTP, R2/S3, Sentry, payment-gateway and FBR/SRB
   setting. Leaving them out is deliberate (see step 7).

6. Start it. The box is already logged in to Docker Hub for live, and the same
   login works here. Either double-click `update.bat`, or run:

   ```powershell
   docker compose pull
   docker compose up -d
   ```

7. Watch the API start:

   ```powershell
   docker compose logs -f sandbox-api
   ```

   You should see `[sandbox] PRACTICE COPY: messages, fiscal filing, … are
   blocked`, then `[entrypoint] applying any new migrations…`, then
   `servd API listening`. Press Ctrl-C to stop watching; the copy keeps
   running.

8. Check it from a browser:
   - https://sandbox-api.servd.pk/api/v1/meta/sandbox shows `{"sandbox":true}`;
   - https://sandbox-api.servd.pk/health shows `"sandbox": true`.

**Database migrations run on the copy at every start.** Each time the practice
API starts, it first brings the practice database up to the version in its
image. That gives you a free dry run of every release on real data. Push the
new release to the practice copy first (see "For IT"). If one of its
migrations fails on real data, the practice API refuses to start
(`FATAL: prisma migrate deploy failed`) and live is untouched. Fix the
migration before it goes to live. Then use **Reset from parent** (step 5) to
get a clean copy, because the database remembers a failed migration and
blocks the next start until it is cleared.

## 4. Log in

1. Open **https://sandbox.servd.pk**. Check for the orange **PRACTICE COPY**
   stripe. If it's missing, stop: you are not on the practice copy.
2. Sign in with the same email and password as on live. Logins were copied
   with the data. A password changed on live after the copy was made doesn't
   carry over, and the other way round.
3. **2FA:** after the right password, the practice copy shows the code on
   screen. Nothing goes to WhatsApp.
4. **Forgot password** doesn't work in the practice copy, because it never
   sends a reset message. An admin can issue a new one in the practice copy:
   **Workforce** → the person → **New password**.
5. **Floor staff who sign in with a WhatsApp code:** a manager makes them a
   code in the practice copy: **Workforce** → **Sign-in code** next to their
   name. The practice copy never shows a code to someone who only typed a
   phone number or email, because anyone could do that.
6. **Till PINs** are the same as on live on the day of the copy.
7. Everyone signs in fresh. Live sessions don't work here, and signing out of
   one copy never signs you out of the other.
8. The till, kitchen screen (KDS) and expo all run in the browser at
   sandbox.servd.pk. The **tablets, the customer app, the rider app and the
   storefront stay connected to live**. Never use them for practice.

## 5. Refresh the copy with today's data

In Neon, go to **Branches** → `practice` → **Reset from parent**.

- **What it wipes:** everything done in the practice copy since the last copy:
  practice orders, payments, edits, new logins, passwords changed there, and
  practice-only settings. All of it is replaced by today's live data. Tell
  people first, because their practice work disappears.
- **What it keeps:** the address and connection string. Live is not touched.
- Afterwards, restart the API so it re-checks the database version:

  ```powershell
  cd C:\servd-sandbox
  docker compose restart sandbox-api
  ```

  People may need to sign in again.
- If you gave the practice copy its own password (step 1, item 6) and the API
  log now says `password authentication failed`, the reset put the old
  password back. Reset the practice password again, put the new connection
  string in `.env`, and run `docker compose up -d`.
- A login disabled on live after the last refresh is still active in the
  practice copy until the next refresh. Disable it there too.

## 6. Switch it off or delete it

**Run these only inside `C:\servd-sandbox`.** Run in the live folder, the same
commands stop the live ERP.

- **Pause it** (everything is kept):

  ```powershell
  cd C:\servd-sandbox
  docker compose stop
  ```

  To start again: `docker compose start`, or double-click `update.bat`. While
  it is paused, the address shows a Cloudflare error page.
- **Remove it completely:**
  1. `cd C:\servd-sandbox` then `docker compose down`. This removes only the
     practice containers and network. Optionally also remove the images:
     `docker image rm ammargarib/servd:api-sandbox ammargarib/servd:admin-sandbox`.
  2. Cloudflare: delete the `servd-practice` tunnel, its two public hostnames
     (and the `sandbox` / `sandbox-api` DNS records if any are left), and the
     Access application.
  3. Neon: delete the `practice` branch. This deletes the copy of real data
     for good.
  4. Delete the `C:\servd-sandbox` folder. Its `.env` holds the practice
     secrets.

## 7. What it never does, and who gets access

**The practice copy never:**
- sends WhatsApp, SMS, email or push messages, to customers, staff or
  suppliers;
- files with FBR or SRB. The fiscal POS and card machine are swapped for the
  built-in test driver: invoice numbers start `TEST-` and receipts say
  "TEST — NOT A FISCAL INVOICE";
- charges or refunds through a card machine or payment gateway;
- acts on Raast bank SMS. Never point a counter phone's SMS forwarder at the
  practice address;
- calls webhooks or posts to social media;
- refreshes the storefront or calls Cloudflare. It has no storefront;
- uploads into the live photo bucket. Photo uploads are switched off in the
  practice copy (cash-voucher photos are kept in the database and still
  work);
- reports errors to Sentry;
- runs timed jobs. Reminders, scheduled reports, auto-publish and the other
  live background jobs don't run on their own;
- shares a database, Redis, secrets, tunnel or network with live. Live sign-ins
  don't work here, and live's stored integration keys can't be read here.

Everything it would have sent is listed (masked) in the API log as
`[sandbox] blocked …`.

**Who should get access:** treat it like live, because it holds the same
personal data.
- Give it only to people who already have that access on live: managers in
  training, finance, and IT (Baqar). Everyone keeps the role they have on live
  as of the day of the copy.
- Don't show it to outsiders. For a demo to someone outside GS Foods, use a
  copy without real personal data, not this one.
- Don't take screenshots of customer details, and don't type new real
  customer data into it.
- When someone leaves, disable them in the practice copy as well as on live
  (or refresh the copy).
- Reports in the practice copy mix real and practice data. Never use them for
  real decisions or tax.

---

## For IT: the practice images

The practice stack runs two images. Neither is ever a live tag.

- **`ammargarib/servd:admin-sandbox`** is built by `deploy/sandbox/build-admin.sh`.
  It bakes in `NEXT_PUBLIC_API_URL=https://sandbox-api.servd.pk`,
  `NEXT_PUBLIC_WS_URL=wss://sandbox-api.servd.pk` and `NEXT_PUBLIC_SANDBOX=1`,
  with no Sentry. It refuses to push a bundle that still contains the live
  API address, and it also pushes the fixed tag `admin-sandbox-<sha>`. Run
  `docker login` first. The script reads no secrets.
- **`ammargarib/servd:api-sandbox`** is the same API image as live, built
  from a commit that has practice mode in it (`backend/src/lib/sandbox.ts`).
  The `SERVD_SANDBOX=1` setting in the practice compose switches practice
  mode on. From the repo root:

  ```bash
  SHA=$(git rev-parse --short=7 HEAD)
  docker build --platform linux/amd64 --label pk.servd.practice=1 \
    -t ammargarib/servd:api-sandbox -t ammargarib/servd:api-sandbox-$SHA backend/
  # Practice mode must be in the image before it is pushed:
  docker run --rm --entrypoint sh ammargarib/servd:api-sandbox \
    -c 'grep -q SERVD_SANDBOX dist/src/lib/sandbox.js' && echo "practice mode present"
  docker push ammargarib/servd:api-sandbox-$SHA
  docker push ammargarib/servd:api-sandbox
  ```

  Re-tagging a live `api-<sha>` build of the same commit works too, after the
  same check.

Rules:
- Never push a practice build as `:api`, `:admin`, `:api-<sha>` or
  `:admin-<sha>`. Never put a live tag in the practice compose.
- Never run `admin-sandbox` on the live stack, because it talks to the
  practice API.
- Never add `sandbox.servd.pk` to the live storefront's `ADMIN_ORIGINS`. The
  storefront editor's live preview stays blank in the practice copy; that is
  expected.
- To hold the practice copy on one build, set `SANDBOX_API_TAG=api-sandbox-<sha>`
  (and/or `SANDBOX_ADMIN_TAG`) in `C:\servd-sandbox\.env`, then run
  `update.bat`.
- Keep the practice images at the same release as live or newer. An older API
  on a newer copied database can misread it.
- Release dry run: build and push `api-sandbox` from the release commit, run
  `update.bat` on the box, and watch `docker compose logs -f sandbox-api` for
  the migrations.

## If something goes wrong

| What you see | What it means |
|---|---|
| `docker compose up` stops with `Set … in .env` | That variable is empty in `.env`. |
| `sandbox-preflight` exits with `REFUSED` and cloudflared doesn't start | The tunnel token doesn't belong to `CF_TUNNEL_ID`, usually because the live token was pasted. Copy the `servd-practice` token. |
| API log: `Practice copy refused to start: DATABASE_URL points at a live host` | `.env` has the live database. Use the practice branch's string (step 1). |
| API log: `SERVD_PROD_HOSTS is not set` | Fill in `SERVD_PROD_HOSTS` (step 3, item 4). |
| API log: `JWT_SECRET is weak` or `must be different values` | Make new values with the PowerShell in step 3. |
| API log: `prisma migrate deploy failed` | A migration failed on the copy. Fix it before it reaches live, then **Reset from parent**. |
| Cloudflare "Bad gateway" | Check the tunnel URLs are exactly `sandbox-admin:3000` and `sandbox-api:3001`, and `docker compose ps` shows everything running. |
| No orange stripe | Wrong address, or the admin image isn't `admin-sandbox`. |
| API keeps restarting (exit 137) | It ran out of memory. Raise `memory` under `sandbox-api` in `docker-compose.yml`. |
