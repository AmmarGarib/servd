# tip-pools

Admin route: **/tip-pools**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — Next.js page component (server or client)

The page lists members with or without a servd login (staff with no login show
"no login" and their employee code), asks for a weight for staff whose HR
record names no tip-pool role, and can add anyone of the pool's company to a
draft (`GET /tip-pools/:id/candidates`, `POST /tip-pools/:id/members`).
