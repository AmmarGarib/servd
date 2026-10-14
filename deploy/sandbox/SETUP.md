# servd practice copy: setup and running it

The practice copy is a second, separate servd where staff can try anything:
ring up orders, void, refund, change menus, run payroll, close a month. None of
it touches the live ERP.

| | Live ERP | Practice copy |
|---|---|---|
| Admin | https://admin.servd.pk | **https://servd-practice.garibsons.app** |
| API | https://api.servd.pk | **https://servd-practice-api.garibsons.app** |
| Who can open it | anyone with a servd login | only the emails on the Cloudflare Access list, **then** a servd login |
| Database | Neon, production branch | Neon, its own branch `practice`: a copy of the real data on the day you make it, with its own password |
| Redis | Upstash | Its own container (`sandbox-redis`) |
| Secrets | Live keys | New keys made only for the practice copy |
| Cloudflare tunnel | the live tunnel | Its own tunnel, `servd-practice` |
| Folder on the box | `C:\servd\deploy` | `C:\servd-sandbox` (Docker project `servd-sandbox`) |

The two copies share nothing. After you make the copy, live changes don't show
up in it and practice changes never go back to live. Every page of the
practice copy has an orange **PRACTICE COPY** stripe at the top, and every tab
title starts with **[PRACTICE]**.

**Why it is not on servd.pk.** A browser treats every address under servd.pk
as the same site as the live API, so a practice page could send requests to
the live API carrying your live sign-in. The practice copy therefore lives
under a different domain, `garibsons.app` (the domain the deploy webhook
already uses). Never move it under servd.pk.

**It holds real personal data.** The copy includes real customers' names,
phone numbers, emails and addresses, plus staff records and sales. That is why
it can never send anything out (see step 7), why it sits behind Cloudflare
Access (step 2), and why access must be limited (step 7).

Before you start you need:
- access to the Neon console (the servd project) and to Cloudflare Zero Trust
  (the account that holds the `garibsons.app` domain);
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
4. **Required: give the copy its own password.** On the new branch, open
   **Roles & Databases**, find the role live uses, and choose **Reset
   password**. Without this, the copy keeps live's database password, and
   anyone who sees the practice `.env` or the practice API's settings only has
   to change the host to open the live database. The reset changes the
   `practice` branch only; live is not touched.
5. Still on the `practice` branch, click **Connect**. Choose branch
   `practice`, the same database and role, and **turn connection pooling
   OFF**. Copy the connection string (it must be the one shown AFTER the
   password reset). It starts with `postgresql://` and ends with
   `?sslmode=require`. This is your `DATABASE_URL`.
6. Check it: the address after `@` starts with `ep-…` and must be **different**
   from the address in live's `DATABASE_URL`, because every Neon branch gets its
   own address. If the two are the same, you copied the live one. Stop and
   copy the practice one. The password in it must not be live's either.

Cost: the branch stores only what changes in it, and its compute can sleep when
nobody uses it. Set its compute to the smallest size with scale-to-zero on.

## 2. Make the Cloudflare tunnel and the Access lock (separate from live)

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
   | `servd-practice` | `garibsons.app` | HTTP | `sandbox-admin:3000` |
   | `servd-practice-api` | `garibsons.app` | HTTP | `sandbox-api:3001` |

   These names are one level under garibsons.app, so Cloudflare's free
   certificate covers them. That is why the API is `servd-practice-api`, not
   `api.servd-practice`.
6. Never add a practice hostname to the live tunnel, and never add a live
   hostname to `servd-practice`.
7. **Required: put BOTH addresses behind Cloudflare Access.** The practice
   copy shows the 2FA code on screen after a correct password (it sends no
   WhatsApp), and its logins and passwords are copied from live. Without
   Access, anyone holding a leaked live password could sign in to a copy of
   every customer, payroll and sales record, and could use it to guess live
   passwords. **The practice API refuses to start without the Access settings,
   and refuses every request that did not come through Access.**
   1. Go to **Access** → **Applications** → **Add an application** →
      **Self-hosted**. Name it `servd practice copy`.
   2. Add **both** public hostnames to this ONE application:
      `servd-practice.garibsons.app` and `servd-practice-api.garibsons.app`.
   3. **Session duration:** 24 hours.
   4. Policy: **Allow**, Include → **Emails** → the email addresses of the
      people on the access list (step 7). Nobody else.
   5. Login method: **One-time PIN** (Cloudflare emails a code) is enough.
   6. Under **Advanced settings** → **Cross-Origin Resource Sharing (CORS)**:
      turn ON **Bypass OPTIONS requests to origin**; set
      **Access-Control-Allow-Origin** to `https://servd-practice.garibsons.app`;
      turn ON **Access-Control-Allow-Credentials**. (The admin calls the API
      from the browser; the API itself only accepts the practice admin.)
   7. Save. Then copy two values for `.env`:
      - **`CF_ACCESS_AUD`**: the application's **Application Audience (AUD)
        Tag** (on the application's Overview / Basic information page);
      - **`CF_ACCESS_TEAM_DOMAIN`**: your team domain,
        `<team>.cloudflareaccess.com` (**Settings** → **Team name and
        domain**).

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
   | `DATABASE_URL` | The practice branch's connection string from step 1, with the practice branch's OWN password |
   | `JWT_SECRET`, `JWT_REFRESH_SECRET` | The two new values from item 3 |
   | `SERVD_SECRET_KEY` | The new 32-byte value from item 3 |
   | `KEENU_WEBHOOK_SECRET` | The new value from item 3 |
   | `SERVD_PROD_HOSTS` | The live hostnames from item 4 |
   | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | From step 2, item 7 |
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

   `up` waits until the API has run its migrations and **proved it is in
   practice mode** (a health check asks it). Only then do the admin and the
   tunnel start. If the API image is not a practice build, or its migrations
   fail, the API stays `unhealthy`, nothing is reachable from outside, and
   `up` stops with an error.

7. Watch the API start:

   ```powershell
   docker compose logs -f sandbox-api
   ```

   You should see `[sandbox] PRACTICE COPY: messages, fiscal filing, … are
   blocked`, then `[entrypoint] applying any new migrations…`, then (on the
   first start of each copy) `[sandbox] scrubbed the copied live data: …`,
   then `servd API listening`. Press Ctrl-C to stop watching; the copy keeps
   running.

8. Check it from a browser (Access asks for your email and a code first):
   - https://servd-practice-api.garibsons.app/api/v1/meta/sandbox shows `{"sandbox":true}`;
   - https://servd-practice-api.garibsons.app/health shows `"sandbox": true`.

**Database migrations run on the copy at every start.** Each time the practice
API starts, it first brings the practice database up to the version in its
image. That gives you a free dry run of every release on real data. Push the
new release to the practice copy first (see "For IT"). If one of its
migrations fails on real data, the practice API refuses to start
(`FATAL: prisma migrate deploy failed`) and live is untouched. Fix the
migration before it goes to live. Then use **Reset from parent** (step 5) to
get a clean copy, because the database remembers a failed migration and
blocks the next start until it is cleared.

**What the first start changes in the copy.** On the first start of each copy
the API cleans out what it copied from live and must not keep: every POS
connector gets a new webhook token, the counter phones for Raast bank SMS,
the outbound webhooks and the push tokens are switched off, and the stored
WhatsApp gateway, Facebook / Instagram page and SMTP login are deleted. It
runs once per copy; a reset from parent makes it run again.

## 4. Log in

1. Open **https://servd-practice-api.garibsons.app/api/v1/meta/sandbox** first.
   Cloudflare asks for your work email and emails you a code. After it you
   see `{"sandbox":true}`. This signs your browser in to the practice API.
2. Open **https://servd-practice.garibsons.app**. Check for the orange
   **PRACTICE COPY** stripe. If it's missing, stop: you are not on the
   practice copy.
   - If the stripe says **"Not signed in to the practice API yet"**, click
     the link in it once (it opens item 1's page), then come back.
   - If the stripe says **"STOP: … NOT in practice mode"**, close the tab and
     tell IT.
   You sign in to Cloudflare again after 24 hours.
3. Sign in with the same email and password as on live. Logins were copied
   with the data. A password changed on live after the copy was made doesn't
   carry over, and the other way round.
4. **2FA:** after the right password, the practice copy shows the code on
   screen. Nothing goes to WhatsApp.
5. **Forgot password** doesn't work in the practice copy, because it never
   sends a reset message. An admin can issue a new one in the practice copy:
   **Workforce** → the person → **New password**.
6. **Floor staff who sign in with a WhatsApp code:** asking for a code says
   "codes are not sent here". A manager makes them a code in the practice
   copy: **Workforce** → **Sign-in code** next to their name; they choose "I
   have a code from my manager". The practice copy never shows a code to
   someone who only typed a phone number or email, because anyone could do
   that.
7. **Till PINs** are the same as on live on the day of the copy.
8. Everyone signs in fresh. Live sessions don't work here, and signing out of
   one copy never signs you out of the other.
9. The till, kitchen screen (KDS) and expo all run in the browser at
   servd-practice.garibsons.app. The **tablets, the customer app, the rider
   app and the storefront stay connected to live**. Never use them for
   practice.

## 5. Refresh the copy with today's data

Tell people first: their practice work disappears.

1. Stop the practice API, so nothing reads the copy while it is replaced:

   ```powershell
   cd C:\servd-sandbox
   docker compose stop sandbox-api
   ```

2. In Neon, go to **Branches** → `practice` → **Reset from parent**.
   - **What it wipes:** everything done in the practice copy since the last
     copy: practice orders, payments, edits, new logins, passwords changed
     there, and practice-only settings. All of it is replaced by today's live
     data.
   - **What it keeps:** the address. Live is not touched.
3. **Required: reset the practice password again** (step 1, item 4). The reset
   from parent puts live's database password back on the practice branch.
   Copy the new connection string into `DATABASE_URL` in `.env`.
4. Start it again: double-click `update.bat` (or `docker compose up -d`). The
   API re-checks the database version and cleans the fresh copy again (step
   3, "What the first start changes"). People need to sign in again.

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
     (and the `servd-practice` / `servd-practice-api` DNS records if any are
     left), and the `servd practice copy` Access application.
  3. Neon: delete the `practice` branch. This deletes the copy of real data
     for good.
  4. Delete the `C:\servd-sandbox` folder. Its `.env` holds the practice
     secrets.

## 7. What it never does, and who gets access

**The practice copy never:**
- sends WhatsApp, SMS, email or push messages, to customers, staff or
  suppliers. Screens that would send a code say so instead of "a code is on
  its way";
- files with FBR or SRB. The fiscal POS and card machine are swapped for the
  built-in test driver: invoice numbers start `TEST-` and receipts say
  "TEST — NOT A FISCAL INVOICE";
- charges or refunds through a card machine or payment gateway;
- acts on Raast bank SMS. Never point a counter phone's SMS forwarder at the
  practice address;
- calls webhooks or posts to social media;
- refreshes the storefront or calls Cloudflare. It has no storefront, so the
  storefront editor's live page, element palette and previews stay blank;
- uploads into the live photo bucket. Photo uploads are switched off in the
  practice copy (cash-voucher photos are kept in the database and still
  work);
- reports errors to Sentry;
- runs timed jobs. Reminders, scheduled reports, auto-publish and the other
  live background jobs don't run on their own;
- shares a database, database password, Redis, secrets, tunnel, network or
  web domain with live. Live sign-ins don't work here, live's stored
  integration keys can't be read here, and the practice API accepts browser
  requests only from the practice admin (never from admin.servd.pk or the
  storefront).

Everything it would have sent is listed (masked) in the API log as
`[sandbox] blocked …`.

**Who should get access:** treat it like live, because it holds the same
personal data. The Cloudflare Access list (step 2, item 7) is the list.
- Give it only to people who already have that access on live: managers in
  training, finance, and IT (Baqar). Everyone keeps the role they have on live
  as of the day of the copy.
- Don't show it to outsiders. For a demo to someone outside GS Foods, use a
  copy without real personal data, not this one.
- Don't take screenshots of customer details, and don't type new real
  customer data into it.
- When someone leaves, remove them from the Access list and disable them in
  the practice copy as well as on live (or refresh the copy).
- Reports in the practice copy mix real and practice data. Never use them for
  real decisions or tax.

---

## For IT: the practice images

The practice stack runs two images. Neither is ever a live tag.

- **`ammargarib/servd:admin-sandbox`** is built by `deploy/sandbox/build-admin.sh`.
  It bakes in `NEXT_PUBLIC_API_URL=https://servd-practice-api.garibsons.app`,
  `NEXT_PUBLIC_WS_URL=wss://servd-practice-api.garibsons.app`,
  `NEXT_PUBLIC_STOREFRONT_URL=https://servd-practice.garibsons.app` and
  `NEXT_PUBLIC_SANDBOX=1`, with no Sentry. It refuses a practice address under
  servd.pk, refuses to push a bundle that still contains the live API address,
  and also pushes the fixed tag `admin-sandbox-<sha>`. Run `docker login`
  first. The script reads no secrets.
- **`ammargarib/servd:api-sandbox`** is the same API image as live, built
  from a commit that has practice mode in it (`backend/src/lib/sandbox.ts`,
  including the Cloudflare Access check). The `SERVD_SANDBOX=1` setting in the
  practice compose switches practice mode on. From the repo root:

  ```bash
  SHA=$(git rev-parse --short=7 HEAD)
  docker build --platform linux/amd64 --label pk.servd.practice=1 \
    -t ammargarib/servd:api-sandbox -t ammargarib/servd:api-sandbox-$SHA backend/ \
  && docker run --rm --entrypoint sh ammargarib/servd:api-sandbox \
       -c 'grep -q SERVD_SANDBOX_ACCESS_AUD dist/src/lib/sandbox.js' \
  && docker push ammargarib/servd:api-sandbox-$SHA \
  && docker push ammargarib/servd:api-sandbox \
  && echo "pushed api-sandbox (practice mode present)" \
  || echo "NOT PUSHED: the build failed, practice mode (with the Access check) is missing, or a push failed"
  ```

  Re-tagging a live `api-<sha>` build of the same commit works too, after the
  same check. Even if a wrong image slips through, the practice compose's
  health check keeps the admin and the tunnel down until the API answers
  `{"sandbox":true}`.

Rules:
- Never push a practice build as `:api`, `:admin`, `:api-<sha>` or
  `:admin-<sha>`. Never put a live tag in the practice compose.
- Never run `admin-sandbox` on the live stack, because it talks to the
  practice API.
- Never move the practice copy under servd.pk, and never add a practice
  address to the live API's or the live storefront's allowed origins
  (`ADMIN_ORIGINS`).
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
| `up` fails with `container sandbox-api is unhealthy` | The API did not prove it is in practice mode within a few minutes: the image is not a practice build, a migration failed, or it refused to start. Read `docker compose logs sandbox-api`. |
| API log: `Practice copy refused to start: DATABASE_URL points at a live host` | `.env` has the live database. Use the practice branch's string (step 1). |
| API log: `SERVD_SANDBOX_ACCESS_TEAM and SERVD_SANDBOX_ACCESS_AUD must be set` or `must be the Zero Trust team domain` | Fill in `CF_ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and `CF_ACCESS_AUD` (step 2, item 7). |
| API log: `SERVD_PROD_HOSTS is not set` | Fill in `SERVD_PROD_HOSTS` (step 3, item 4). |
| API log: `password authentication failed` | After a reset from parent, the practice branch has live's password again. Reset it (step 5, item 3) and update `DATABASE_URL`. |
| API log: `JWT_SECRET is weak` or `must be different values` | Make new values with the PowerShell in step 3. |
| API log: `prisma migrate deploy failed` | A migration failed on the copy. Fix it before it reaches live, then **Reset from parent**. |
| API log: `could not scrub the copied live data` | The first-start clean-up failed, so the API won't serve the copy. Read the message; usually the database was unreachable. |
| Stripe: "Not signed in to the practice API yet", or the API answers `ACCESS_REQUIRED` | Open https://servd-practice-api.garibsons.app/api/v1/meta/sandbox once in the same browser and sign in. If it keeps happening, check that BOTH hostnames are in the one Access application and that `CF_ACCESS_AUD` is that application's AUD tag. |
| Stripe: "STOP: … NOT in practice mode" | The admin is talking to an API that is not in practice mode. Stop the practice copy (`docker compose stop`) and tell IT. |
| Cloudflare "Bad gateway" | Check the tunnel URLs are exactly `sandbox-admin:3000` and `sandbox-api:3001`, and `docker compose ps` shows everything running. |
| No orange stripe | Wrong address, or the admin image isn't `admin-sandbox`. |
| API keeps restarting (exit 137) | It ran out of memory. Raise `memory` under `sandbox-api` in `docker-compose.yml`. |
