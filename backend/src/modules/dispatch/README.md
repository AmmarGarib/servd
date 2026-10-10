# dispatch

Backend module: **dispatch**. HTTP routes + business logic for the Dispatch domain. Registered into Fastify by `src/index.ts` under the `/dispatch` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module
- `service.ts` — the one set of rider rules: assign / take off / deliver (every
  write a claim), `riderOpenOrderWhere` (THE "still on the rider's hands"
  predicate — the board, the rider's job list and freeing a rider all read
  it), job events, hand-over-code attempt slots, location fixes

## Rules worth knowing

- `POST /orders/:id/delivered` on a rider-app job (`riderAssignedAt` set) is
  a MANAGERS override, allowed only once the hand-over code has locked or if
  the rider never accepted; otherwise 409 `RIDER_CLOSES_WITH_CODE`. Orders from
  before the rider app keep the old rule. A second press is `alreadyDelivered`.
- The board's orders carry `deliveryOtpAttempts`, never `deliveryOtp`.
- The rider app's own fix (`POST /rider/location`) is refused with 409
  `OFF_SHIFT` while the rider is offline; the staff relay here is not.
