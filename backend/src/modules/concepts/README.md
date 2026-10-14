# concepts

Backend module: **concepts**. HTTP routes + business logic for the Concepts domain. Registered into Fastify by `src/index.ts` under the `/concepts` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module

## Service vessel (owner's FINAL packaging rule, 2026-10-13)

`Concept.serviceVessel` is the brand's primary service vessel: `'plate'` (dishes go out on plates — a dish's
Packaging section is used on takeaway / delivery, and on dine-in only when staff tap "Box given") or `'packaging'`
(packaging IS the vessel, e.g. Stackd — used on every order). It is a REQUIRED choice when a brand is created:
`POST /concepts` and the company route that makes a brand (`POST /tenants/apply-template`) answer 400 without it —
no API default. Management changes it with `PATCH /concepts/:id` ('write' scope; another company's brand 404),
audited as `concept.service_vessel` with `before` / `after` on the brand's company. A change applies to order lines
rung up from then on: `OrderItem.serviceVessel` is snapshotted at ring-up, so past food cost is never restated.
The full GET responses carry it.
