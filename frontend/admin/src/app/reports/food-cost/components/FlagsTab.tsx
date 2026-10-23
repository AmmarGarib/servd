'use client'
// Flags: the company's open stock flags and refused stock postings —
// read-only here; acknowledging and resolving stay in Exceptions.
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { ErrorNote, Section, pkr } from './ui'
import type { FlagRow } from './types'
import { CompactEmptyState } from '../../../../components/ui/CompactEmptyState'

const KIND_LABEL: Record<string, string> = {
  shrinkage: 'Count shrinkage', shrinkage_trend: 'Shrinkage trend', yield_low: 'Low prep yield', stock_shortfall: 'Sold beyond stock',
  stock_unrecorded: 'Stock with no receipt', recipe_foreign_stock: 'Recipe uses another company\'s item', posting_failed: 'Posting refused',
}
const SEVERITY_BADGE: Record<string, string> = { critical: 's-badge-red', high: 's-badge-red', medium: 's-badge-amber', low: 's-badge-muted' }

export function FlagsTab({ tenantId }: { tenantId: string }) {
  const { data, error, isLoading } = useQuery<{ flags: FlagRow[] }>({
    queryKey: ['food-cost', 'flags', tenantId],
    queryFn: () => api.get(`/reports/food-cost/flags?tenantId=${encodeURIComponent(tenantId)}`),
  })
  return (
    <Section title="Stock flags" hint="Open flags on stock and refused stock postings. Acknowledge or resolve them in Exceptions." right={<Link href="/exceptions" className="text-xs text-primary-ink hover:underline">Exceptions</Link>}>
      <ErrorNote error={error} />
      {isLoading ? <p className="py-6 text-center text-sm text-s-dim">Loading…</p> : (data?.flags ?? []).length === 0 ? (
        <CompactEmptyState message="No open stock flags" />
      ) : (
        <div className="overflow-x-auto">
          <table className="s-table">
            <thead><tr><th>Raised</th><th>Kind</th><th>What</th><th>Severity</th><th className="text-right">Amount</th><th /></tr></thead>
            <tbody>
              {data!.flags.map((f) => (
                <tr key={f.id}>
                  <td>{f.createdAt.slice(0, 10)}</td>
                  <td>{KIND_LABEL[f.kind] ?? f.kind}</td>
                  <td className="whitespace-normal">{f.title}</td>
                  <td><span className={SEVERITY_BADGE[f.severity] ?? 's-badge-muted'}>{f.severity}</span></td>
                  <td className="text-right font-mono">{f.amountCents == null ? '—' : pkr(f.amountCents)}</td>
                  <td><Link href={f.link} className="text-xs text-primary-ink hover:underline">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
