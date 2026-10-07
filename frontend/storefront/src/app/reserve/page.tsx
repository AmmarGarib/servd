// /reserve — top-level reservation landing.
// Lists brands that accept reservations (reservationsEnabled !== false)
// so a customer who lands here without a brand context can pick one.
//
// The page is content (SiteLayout `servd:reserve`, Admin → Storefront);
// nothing published → the default sections (header + the live brand picker).

import { ManagedPage } from '../../sections/ManagedPage'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Reserve a table',
  description: 'Book a table at a servd brand — Simmer, and any other kitchen that takes reservations.',
}

export default async function ReservePage() {
  return (
    <main className="surface-bg" style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <ManagedPage slug="servd:reserve" />
    </main>
  )
}
