# giftCards

Backend module: **giftCards**. HTTP routes + business logic for the Gift Cards domain. Registered into Fastify by `src/index.ts` under the `/gift-cards` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module (list, books check, issue, book a missing issue, balance, redeem, void)
- `service.ts` — THE redeem engine (storefront checkout, the till tender, POST /gift-cards/redeem)
- `books.ts` — gift cards in the books: issue + its 2080 entry in one transaction, void with a disposition, the expiry sweep (`workers/giftCardExpiry.ts`), the 2080 books check
