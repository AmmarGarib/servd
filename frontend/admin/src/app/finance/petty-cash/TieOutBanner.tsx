'use client'
// Do the boxes agree with the books? GET /trustops/petty-cash/tie-out: per
// company, the boxes' floats against 1011 Petty cash, open cash advances
// against 1355, and movements not yet booked. Green when it all agrees; red
// with what is off otherwise, and a pointer to the CEO's history backfill
// (Reconciliation → Backfill) when old movements are not on the books yet.

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { pkr } from './ui'

interface Row {
  tenantId: string
  tenantName: string | null
  floatsCents: number
  ledger1011Cents: number
  openAdvancesCents: number
  ledger1355Cents: number
  unbookedMovements: number
  boxesWithoutOpening?: number
  ok: boolean
}

export function TieOutBanner() {
  const { data } = useQuery<{ companies: Row[] }>({
    queryKey: ['petty-cash-tie-out'],
    queryFn: () => api.get('/trustops/petty-cash/tie-out'),
    retry: false, meta: { background: true },
  })
  const rows = data?.companies ?? []
  if (rows.length === 0) return null
  const allOk = rows.every((r) => r.ok)
  const tone = allOk ? 'var(--erp-success)' : 'var(--erp-danger)'
  const many = rows.length > 1
  return (
    <div className="rounded-2xl px-5 py-4 space-y-2" style={{ background: `color-mix(in srgb, ${tone} 7%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)` }}>
      <p className="text-sm font-black" style={{ color: tone }}>
        {allOk ? 'The boxes agree with the books' : 'The boxes and the books do not agree yet'}
      </p>
      {rows.map((r) => {
        const gaps: string[] = []
        if (r.floatsCents !== r.ledger1011Cents) gaps.push(`boxes hold ${pkr(r.floatsCents)}, 1011 Petty cash shows ${pkr(r.ledger1011Cents)}`)
        if (r.openAdvancesCents !== r.ledger1355Cents) gaps.push(`open cash advances ${pkr(r.openAdvancesCents)}, 1355 shows ${pkr(r.ledger1355Cents)}`)
        if (r.unbookedMovements > 0) gaps.push(`${r.unbookedMovements} older movement${r.unbookedMovements === 1 ? '' : 's'} not booked`)
        if ((r.boxesWithoutOpening ?? 0) > 0) gaps.push(`${r.boxesWithoutOpening} box opening${r.boxesWithoutOpening === 1 ? '' : 's'} not booked`)
        return (
          <p key={r.tenantId} className="text-xs text-white/60">
            {many && <span className="font-bold text-white/75">{r.tenantName ?? 'Company'}: </span>}
            {r.ok ? `${pkr(r.floatsCents)} in the boxes = 1011 Petty cash` : gaps.join(' · ')}
          </p>
        )
      })}
      {!allOk && (
        <p className="text-xs text-white/55">
          History from before petty cash was booked is put on the books by the CEO in{' '}
          <Link href="/reconciliation" className="font-bold underline" style={{ color: 'var(--erp-primary)' }}>Reconciliation → Backfill</Link>
          {' '}(dry run first). A difference that remains after that is a float changed outside servd — count the box.
        </p>
      )}
    </div>
  )
}
