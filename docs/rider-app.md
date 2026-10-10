# Rider app (own fleet) — v1 contract

Owner decisions (2026-10-10):

- **Two clients, one API**: a native Expo app in `rider/` (needed for location
  while the phone is locked) and a web version at **servd.pk/rider** (no app
  store; location only while the page is open).
- **Login**: phone number + a WhatsApp code. A manager must first add the rider
  in admin → Riders; an unknown number gets the same answer as a known one.
- **v1 scope**: jobs (accept / decline, navigate, picked up → arrived →
  delivered), live location while on shift, the customer's code at hand-over.
  **Not v1**: earnings and payouts (later: models, nightly worker, admin).
- **Shared fleet**: GS Foods runs shared staff for every company, the way it
  runs head office, and the cost is split between the companies. So a rider
  belongs to ONE company (the employer — `Rider.tenantId`, GS Foods), and that
  company's fleet can deliver for other companies through an explicit
  **fleet agreement** (provider company → client company). Every job event is
  stamped with the client company, which is what a later cost split reads.

This is a deliberate, documented exception to company separation: a rider of
company A may carry an order of company B **only** while an active
`FleetAgreement { providerTenantId: A, clientTenantId: B }` exists. Nothing
else crosses: the rider sees only the orders assigned to them, and company B's
staff see only the riders carrying B's orders.

## Data model (migration `20261010120000_rider_app`)

- `Order` gains `riderAssignedAt`, `riderAcceptedAt`, `pickedUpAt`,
  `arrivedAt` (`deliveredAt` already exists).
- `RiderJobEvent { id, riderId, orderId, tenantId (the ORDER's company — the
  client), riderTenantId (the rider's company — the provider), type, lat?, lng?,
  note?, createdAt }`; `type` ∈ `offered | accepted | declined | timed_out |
  picked_up | arrived | delivered | otp_failed | unassigned`. Indexed by
  `(orderId)`, `(riderId, createdAt)`, `(tenantId, createdAt)`.
- `FleetAgreement { id, providerTenantId, clientTenantId, isActive,
  createdById, createdAt, updatedAt }`, `@@unique([providerTenantId,
  clientTenantId])`. Created/ended only by an operator who belongs to BOTH
  companies (their write scope covers both).
- `Rider.phone` is stored normalised (`normalisePhone`, `92…` digits) from now
  on; the migration normalises existing rows.

## Auth (`/api/v1/rider-auth`, public, rate-limited)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/rider-auth/otp/request` | `{ phone }` | `202 { sent: true }` — always the same, known number or not. Sends a 6-digit WhatsApp code (`requestOtp`, purpose `rider_login`) only when exactly one active, non-deleted rider with a company has that normalised phone. Limits: per IP and per phone (reuse `loginRateLimit` buckets). |
| POST | `/rider-auth/otp/verify` | `{ phone, code }` | `200 { accessToken, refreshToken, rider }` or `401 { error: { code: 'INVALID_CODE' } }` |
| POST | `/rider-auth/refresh` | `{ refreshToken }` | `200 { accessToken, refreshToken }` (rotated; the old one is revoked) |
| POST | `/rider-auth/logout` | `{ refreshToken? }` + Bearer | `204` (both tokens revoked) |

Tokens are JWTs with `type: 'rider'` / `'rider_refresh'` and `sub = rider.id`
(access 15 min, refresh 30 days). They are rejected everywhere a staff token is
expected, and staff tokens are rejected on `/rider/*`. A rider is NOT a `User`
(a `User` with a rider role would inherit every ALL_STAFF route, including the
hand-over code).

`rider` object: `{ id, name, phone, vehicleType, status, companyName }`.

## Rider API (`/api/v1/rider`, Bearer rider access token)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/rider/me` | — | `{ rider }` |
| POST | `/rider/shift` | `{ online: boolean }` | online → `available` (or `busy` if carrying a job); offline → `offline`, refused (409 `ACTIVE_JOBS`) while carrying an accepted job. |
| GET | `/rider/jobs` | — | `{ jobs: Job[] }` — orders with `riderId = me` that are not finished/cancelled, oldest first. |
| GET | `/rider/jobs/:orderId` | — | `{ job: Job }`; 404 unless assigned to me. |
| POST | `/rider/jobs/:orderId/accept` | `{ lat?, lng? }` | offered → accepted. |
| POST | `/rider/jobs/:orderId/decline` | `{ reason?, lat?, lng? }` | unassigns; the auto-dispatcher never re-offers this order to this rider. |
| POST | `/rider/jobs/:orderId/picked-up` | `{ lat?, lng? }` | needs accepted; order must be `ready` (409 `NOT_READY` otherwise). Sends the customer their code on WhatsApp (best effort). |
| POST | `/rider/jobs/:orderId/arrived` | `{ lat?, lng? }` | needs picked up. |
| POST | `/rider/jobs/:orderId/deliver` | `{ otp, lat?, lng? }` | needs picked up; verifies the customer's code (timing-safe). Wrong → `403 OTP_MISMATCH { attemptsLeft }`; after 5 wrong codes `423 OTP_LOCKED` (a manager marks it delivered from admin → Dispatch). Right → `markDelivered(..., { otpVerified: true })`. |
| POST | `/rider/location` | `{ lat, lng, heading?, accuracy?, speedMps?, orderId? }` | Same validation as `/dispatch/riders/:id/location`, for the signed-in rider only. Rate limit keyed on the rider, not the IP (carrier NAT). Emits `rider:location`. |

`Job`:

```ts
{
  orderId, orderNumber, status,            // order status
  stage: 'offered' | 'accepted' | 'picked_up' | 'arrived',
  brand: { name, slug },
  company: { id, name },                   // the client company
  pickup: { name, address, lat, lng, phone },      // the kitchen (concept)
  dropoff: { name, phone, address, lat, lng },     // customer; address = deliveryNotes text; lat/lng when known
  itemCount, items: [{ name, qty }],
  cashToCollectCents,                      // pending cash payment (COD), 0 when prepaid
  notes,
  assignedAt, acceptedAt, pickedUpAt, arrivedAt,
  otpAttemptsLeft,
}
```

## Fleet agreements (staff, managers)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/riders/fleet/agreements` | — | `{ agreements: [{ id, providerTenantId, providerName, clientTenantId, clientName, isActive, updatedAt }], companies: [{ id, name }] }` — agreements touching any company the operator belongs to; `companies` = the operator's companies (the choices in the form). |
| PUT | `/api/v1/riders/fleet/agreements` | `{ providerTenantId, clientTenantId, isActive }` | upsert → the agreement. 403 unless the operator belongs to BOTH companies; 422 when provider = client. |

## Dispatch changes

- `assignRider` accepts a rider of the order's company **or** of a company with
  an active fleet agreement for it. It writes `riderAssignedAt` and an
  `offered` event.
- The auto-dispatcher (`workers/riderDispatch.ts`) looks at delivery orders
  (`fulfilmentType = 'delivery'`, no rider, status `confirmed | preparing |
  ready`), takes candidates from the order's company plus its providers, skips
  riders who declined that order, and times out an offer nobody accepted in
  3 minutes (`timed_out` event, unassigned, next rider).
- Cancelling an order frees its rider (`unassigned` event).
- Location fixes no longer flip an admin-set `offline` rider back to
  `available`; going on shift is the rider's own action.
- `rider_locations` older than 24 h are pruned.
- Realtime: `rider:location { riderId, lat, lng, heading, recordedAt, orderId }`
  to `tenant:{riderCompany}` and, when on a job, `tenant:{orderCompany}:orders`.

## The hand-over code

- Generated with `crypto.randomInt` (4 digits), compared timing-safe.
- The customer sees it on their order tracker once a rider is assigned, and
  gets it on WhatsApp at pick-up.
- Staff no longer see it in order lists; only admin / management can read it
  (for support).

## Clients

- `rider/` — Expo SDK 52 (same as `tablet/`), expo-router, SecureStore session,
  background location (`expo-task-manager`, Android foreground service, iOS
  `UIBackgroundModes: location`) while on shift.
- `frontend/storefront/src/app/rider/` — servd.pk/rider: same flows, location
  via `navigator.geolocation.watchPosition` while open; noindex, not in the
  sitemap, disallowed in robots.txt, no servd chrome or feedback button.
- Admin → Riders: fleet agreements ("this fleet also delivers for …"),
  delivery-only boards (`fulfilmentType === 'delivery'`, not `source !== 'pos'`).
