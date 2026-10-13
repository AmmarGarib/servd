# procurement

Backend module: **procurement**. HTTP routes + business logic for the Procurement domain. Registered into Fastify by `src/index.ts` under the `/procurement` URL prefix.

## Files

- `chat.ts` — TypeScript module
- `creditNotes.ts` — supplier credit notes / returns (SupplierBill rows of kind `credit_note`): create, apply, unapply, void
- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers (POs, bills, payments incl. unapply / void, AP aging, reorder)
