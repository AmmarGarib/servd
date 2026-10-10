# account

Storefront route: **/account**. Customer-facing page rendered via Next.js App Router.

## Files

- `page.tsx` — Next.js page component (server or client)

## Saved addresses

The add and edit form has a map pin (`components/checkout/DeliveryPin.tsx`).
An address cannot be saved without one, because delivery is priced by zone
and the rider drives to the pin. Saving sends `lat`/`lng` with
`POST /storefront/addresses` or `PATCH /storefront/addresses/:id`. Older
addresses without a pin are marked "No map pin yet". The customer can pin them
here with Edit, or at checkout, which saves the pin back to the address.
