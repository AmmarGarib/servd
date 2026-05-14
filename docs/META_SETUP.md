# Meta (Facebook + Instagram) Connect — operator runbook

The codebase is wired end-to-end for Meta publishing — the only thing that
stops the **Connect** button on `/settings/integrations` from working is
that the Meta App itself doesn't exist yet. Meta has no API for creating
the app; you have to do this once, manually, while logged in as you. This
runbook is the shortest path that exists.

Plan for ~25 minutes the first time. The App Review step at the end is
asynchronous (Meta humans review your submission, 3–10 days typical).

---

## 0. Before you start, you'll need

- A personal Facebook account.
- A **Facebook Page** for the restaurant (not a personal profile).
- An **Instagram Business** account *linked to that Page* — convert from
  personal in the IG app: Settings → Account → Switch to Professional →
  Business → connect FB Page.
- Your business registration docs (NTN cert / SECP cert / utility bill) —
  Meta asks for these during Business Verification.

If any of those don't exist, stop and create them first. The rest of this
won't work without them.

---

## 1. Create the Meta App

1. Go to https://developers.facebook.com/apps and sign in.
2. Click **Create App**.
3. Use case: **Other** → next → **Business** → next.
4. App name: `servd-<your-brand>` (e.g. `servd-stax`). Display name and
   contact email — fill in. Don't tick "Test App".
5. Click **Create app** → you'll be challenged for your Facebook password.

You land on the App Dashboard. Copy two things straight into
`backend/.env`:

```
FACEBOOK_APP_ID="<App ID from the dashboard header>"
FACEBOOK_APP_SECRET="<click 'Show' next to App Secret>"
```

Then restart the backend (`npm run dev` in `c:\Dev\servd`).

---

## 2. Add the products

In the left sidebar of the App Dashboard, click **Add product**.

- **Facebook Login for Business** → Set up.
- **Instagram** → Set up.

For Facebook Login for Business:
- Settings → **Valid OAuth Redirect URIs**: paste
  `http://localhost:3001/api/v1/integrations/social/callback`
  (and your production callback when you deploy — comma-separated).
- **Client OAuth Login**: ON.
- **Web OAuth Login**: ON.
- Save Changes.

---

## 3. Add the permissions (scopes)

App Dashboard → **App Review** → **Permissions and Features**. Request
advanced access to all four — these are the scopes the codebase asks for
in [`backend/src/lib/meta-social.ts`](../backend/src/lib/meta-social.ts):

| Permission                    | Why we need it                                       |
| ----------------------------- | ---------------------------------------------------- |
| `pages_manage_posts`          | Publish Facebook Page posts from Content Calendar.   |
| `pages_read_engagement`       | Read the Page list so we can pick the right one.     |
| `instagram_basic`             | Read the IG Business account linked to the Page.     |
| `instagram_content_publish`   | Publish IG posts from Content Calendar.              |

You'll see two access levels: **Standard Access** (works only for users
listed as app developers/testers) and **Advanced Access** (works for any
user — required for production). For local testing Standard is fine; for
production you have to submit for App Review (step 6).

---

## 4. Business Verification

App Dashboard → **Settings → Basic** → scroll to **Business Verification**.

- Pick / create a Business Manager.
- Upload one of: SECP certificate, NTN certificate, recent utility bill
  in the business name. Add your business address.
- Submit.

Meta will email confirmation within a few days. You can proceed with the
rest of the runbook in parallel — they're independent.

---

## 5. Test the connection (local)

With `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` filled in and the
backend restarted:

1. Open `http://localhost:3000/settings/integrations`.
2. Click **Connect** on the Facebook & Instagram card.
3. You'll be redirected to Facebook's OAuth dialog. Approve.
4. You'll land back on `/settings/integrations?social_connected=…`.

If you see "FACEBOOK_APP_ID not configured" — the backend didn't pick up
your env edit; double-check the file path is `backend/.env` (not the root
`.env`) and restart.

If Facebook says "App Not Set Up: This app is still in development mode":
add yourself as a Developer / Tester role in App Dashboard → App Roles.
Standard Access only works for these roles until App Review passes.

---

## 6. App Review (production)

Once you've tested the flow end-to-end with your own account, you submit
for App Review so other users (your staff) can connect their own
accounts, and so the app can publish without you being a test user.

App Dashboard → **App Review → Permissions and Features** → for each of
the four scopes above, click **Request advanced access**.

For each request Meta wants:

- **Use case description**: paste the snippet from
  [docs/META_REVIEW_COPY.md](META_REVIEW_COPY.md) (created when you're ready
  to submit — ask the codebase agent for it).
- **Screencast**: record yourself clicking Connect on `/settings/integrations`,
  authorising, then scheduling a post in Content Calendar that publishes
  to FB/IG. 60–90 seconds is plenty.
- **Privacy policy URL**: needs to live at `${WEB_URL}/privacy`. Stub copy
  available — ask the codebase agent if you don't have one.
- **Terms of service URL**: same.

Meta reviews and replies in 3–10 business days. They sometimes reject for
trivial reasons (forgot to include a step in the screencast); just resubmit.

---

## 7. After approval

- Switch the app from **Development** to **Live** in the App Dashboard
  toggle at the top.
- Re-test the Connect flow with a non-developer FB account to confirm.
- That's it — staff can connect their own accounts via
  `/settings/integrations`.

---

## Troubleshooting

| Error                                                  | Cause / fix |
| ------------------------------------------------------ | ----------- |
| `Missing or malformed Authorization header`            | Fixed in commit 7e0642c. Pull latest. |
| `FACEBOOK_APP_ID not configured`                       | `.env` missing values or backend not restarted. |
| `URL Blocked: This redirect failed because…`           | Redirect URI in step 2 doesn't exactly match `API_URL`. Trailing slash matters. |
| `Pages cannot be retrieved at this time` after consent | Your FB account isn't an admin of the Page. Go to Meta Business Suite → assign your FB account as Page admin. |
| `No Facebook Pages found for this account`             | Same as above — no Page admin role. |
| `Instagram Business account not linked`                | In Meta Business Suite → Settings → Accounts → Instagram accounts → connect your IG to the Page. |

If you hit something not listed here, paste the exact error text back to
the codebase agent — most Meta errors map to one of three things and we
can route it from the message.
