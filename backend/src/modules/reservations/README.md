# reservations

Backend module: **reservations**. HTTP routes + business logic for the Reservations domain. Registered into Fastify by `src/index.ts` under the `/reservations` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module

## Customer bookings — servd members only (UX-5, owner 2026-10-16)

- `POST /reservations/public` (storefront, mobile) needs a signed-in customer:
  401 `AUTH_REQUIRED` (`details.signInToBook`) otherwise. The booking's phone
  and email are the ACCOUNT's own; typed ones are ignored. `guestName` is
  optional (defaults to the account name).
- No "how far ahead" limit for members (`maxAdvanceDays` is not applied on
  this route; still applied to staff bookings). Not in the past / minimum
  notice / hours / closures / capacity still apply.
- At most `MAX_ACTIVE_BOOKINGS_PER_ACCOUNT` (5) live bookings per account,
  SERVD-WIDE (every brand of every company, like strikes):
  `activeBookingsWhere` = booked / confirmed / seated, not waiting list,
  sitting not yet ended — staff-made bookings linked to the account count
  too. Counted under `pg_advisory_xact_lock('reservations:customer:<id>')`,
  taken BEFORE the brand lock. Over the cap: 409 `BOOKING_LIMIT_REACHED`.
- `GET /reservations/availability` stays open to signed-out visitors.
- Staff bookings (`POST /reservations`) are not capped.
