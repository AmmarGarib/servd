# servd rider

The phone app for GS Foods' own delivery riders. Portrait Expo app (SDK 52,
same stack as `tablet/`). The contract it codes to — owner decisions, data
model and API — is [`docs/rider-app.md`](../docs/rider-app.md). A web version
of the same flows lives at **servd.pk/rider**
(`frontend/storefront/src/app/rider/`) for riders who don't install the app;
it can only share location while the page is open, which is why this native
app exists.

## What's in it (v1)

- **Sign in** — phone number, then a 6-digit code on WhatsApp
  (`/rider-auth/otp/request` → `/rider-auth/otp/verify`). A manager must add
  the rider in admin → Riders first; the server answers unknown numbers the
  same as known ones, so the app never says "number not found". Resend after
  30 s.
- **Jobs** — on/off shift switch (`POST /rider/shift`), the rider's jobs with
  stage badges, pull to refresh, polled every 15 s while on shift.
- **Job** — brand + company, pick-up and drop-off with **Navigate** (Google
  Maps directions) and **Call**, items, cash to collect, and one step button
  for the stage: Accept / Decline → Picked up → Arrived → Enter customer code
  (4 digits, attempts left; locked after 5 → call the kitchen, a manager marks
  it delivered from admin → Dispatch).
- **Profile** — name, phone, company, vehicle, sign out.
- **Live location while on shift** — `expo-location` +
  `expo-task-manager` background task (Android foreground service with a
  "servd rider — on shift, sharing location" notification; iOS
  `UIBackgroundModes: location`). Fixes go to `POST /rider/location` every
  ~10 s / 25 m, tagged with the job being carried (picked up / arrived). If
  the rider refuses "Allow all the time" / "Always", it falls back to sharing
  only while the app is open and says so on the Jobs screen. Going off shift
  or signing out stops it.

Not in v1: earnings and payouts, push notifications for new offers (offers
show up while the app is open; the list polls every 15 s on shift).

## Layout

```
index.ts                 entry — defines the location task, then expo-router
app/_layout.tsx          session hydrate, React Query, auth gate
app/login.tsx            phone -> WhatsApp code
app/(rider)/_layout.tsx  keeps location sharing in step with the shift
app/(rider)/(tabs)/      Jobs (index) and Profile
app/(rider)/job/[orderId].tsx   job detail + the step button
src/lib/api.ts           Bearer + one shared refresh (/rider-auth/refresh, rotating)
src/lib/location.ts      background task, foreground fallback, permissions
src/lib/theme.ts         the ONE colour file (servd tokens)
src/store/session.ts     zustand session persisted to SecureStore
```

## Run

```bash
cd rider
npm install
npx expo start            # then a dev build on the phone (see below)
```

The API host is `app.json → expo.extra.apiUrl` (default
`https://api.servd.pk`). Point it elsewhere without editing the file:

```bash
SERVD_API_URL=http://192.168.1.42:4000 npx expo start
```

Background location needs a **development build** (`npx expo run:android` /
`run:ios`, or an EAS dev build). Expo Go can't run the background task on iOS;
the app notices and falls back to sharing while it is open.

## Dependencies to keep

- `expo-asset` — required by Expo SDK 52's Metro config; without it nothing
  bundles (`expo start` / `expo export` fail with "The required package
  `expo-asset` cannot be found").
- `query-string@7` — expo-router 4.0's navigation-state fork still imports it,
  but `@react-navigation/core` stopped shipping it after 7.0, so a fresh
  install can't resolve it. Remove only after moving to an expo-router that
  no longer imports it. Check with `npx expo export --platform android`.

## Store builds

EAS build + Play Store / App Store submission is a later step (needs an
`eas.json`, app icons and splash, and the Play "background location"
declaration — the in-app disclosure it requires is already shown before the
"Allow all the time" prompt).

## Rules

- Colours only from `src/lib/theme.ts` (servd tokens: bone `#f3e7cd`, green
  `#87c540` with purple text on it, purple `#5a2156`, ink `#3d1f3b`).
- No emoji icons — text labels and simple shapes.
- Brand names through `formatBrandName()` (`src/lib/brand.ts`, a copy of the
  storefront's).
- The rider sees only jobs assigned to them; the client company on a job is
  shown because a GS Foods rider can deliver for another company under a
  fleet agreement (see the contract).
