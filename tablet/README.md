# servd Staff Tablet

Android-first landscape Expo app for in-shift staff. Companion to the customer
`mobile/` app — same backend, completely different audience.

## What's in it

- **PIN login** — multi-user, geofence-enforced, optional selfie
- **KDS** — all-orders expediter view + per-station ticket lanes
- **Reservations** — host stand day view with seat / no-show actions
- **Curbside** — "Cars here" / "En route" queue with arrived button
- **Time clock** — selfie + geo punch
- **Inventory** — stock count with camera barcode scan
- **Customer** — phone lookup with strikes / loyalty / order history
- **Dispatch** — live rider map + assign rider

Not a till (owner decision 1, 2026-09-27): orders are rung up, paid and the
drawer is counted on the admin web POS (`/pos`). The tablet's POS, tender,
shift and active-orders screens were retired.

Live updates via Socket.IO. Bluetooth ESC/POS thermal printer pairing
(generic 58mm/80mm — protocol-based so any cheap Goojprt / Xprinter works).

## Run

```bash
cd c:/Dev/servd/tablet
npm install
npm run android        # Expo Go on tablet, or build dev client
```

Set the API host in `app.json -> expo.extra.apiUrl`. Default `http://10.0.2.2:4000`
hits the dev backend from an Android emulator. On a real tablet, use the LAN IP
of the dev machine (e.g. `http://192.168.1.42:4000`).

## Kiosk / device lockdown

Android tablets running this app should be set as **Device Owner** with the app
pinned via the Lock Task Mode API (or simpler: use Samsung Knox / Scalefusion /
Hexnode / any MDM). The app already keeps the screen awake while open via
`expo-keep-awake`.

## Production

Build with EAS:

```bash
eas build --platform android --profile preview
```

Distribute the resulting APK via MDM or sideload.
