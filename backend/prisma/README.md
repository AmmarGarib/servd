# backend/prisma

Database schema + migration history.

## Files

- `schema.prisma` — Single source of truth for the database. Hot-reload friendly: edit, then `npm run db:migrate` (or `npx prisma db push` for local-only changes).
- `seed.ts` — Seeds default concepts (Stax, Strata, Flipd, Simmer) + sample staff.
- [`migrations/`](./migrations/) — Prisma-managed migration history (do not edit by hand).

## Conventions

- Column names stay **camelCase** (e.g. `scheduledFireAt`, not `scheduled_fire_at`) — this matches the Prisma field name. If you write a hand-rolled migration, follow this convention or add `@map("snake_case")` to the field.
- Every model has a `@@map("snake_case_table")` directive at the bottom. Tables are snake_case in the DB, models are PascalCase in code.
- `createdAt`, `updatedAt`, `deletedAt` (soft-delete) are present on most user-facing entities.
