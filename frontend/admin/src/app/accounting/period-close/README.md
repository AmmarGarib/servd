# period-close

Admin route: **/accounting/period-close**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — the one close / reopen of a company's books (CEO only). Before a
  close it reads `GET /accounting/period-close?lockedThrough=<date>`
  `raastUnmatched {count, cents, through}`: Raast QR payments still provisional
  or needing attention up to that date. With any, the page warns and the close
  needs the CEO's "close anyway" tick (`closeWithUnmatchedRaast: true`,
  audited `period.close_with_unmatched_raast`); otherwise the API answers 409
  `RAAST_UNMATCHED`.
