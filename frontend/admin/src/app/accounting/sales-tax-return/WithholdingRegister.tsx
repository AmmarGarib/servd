'use client'
// Withholding register (H8 / H28) — one row per income-tax deduction from a
// vendor: supplier bills, paid OpEx payments and paid CapEx payments, for the
// CA's s.165 statement. Reads the active company, or every company in
// "All companies" view.
//   GET /accounting/withholding/register?from&to[&format=csv]
//     → { from, to, rows, totals: { baseCents, whtCents, bySection }, note }
// Every figure is the server's.
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { ExportMenu } from '@/components/ui/ExportMenu'

type Section = '153_1_a' | '153_1_b' | '153_1_c' | '155'
interface Row {
  tenantId: string
  company: string
  date: string
  source: 'supplier_bill' | 'opex' | 'capex'
  sourceId: string
  document: string
  vendor: string
  ntn: string | null
  filerStatus: string | null
  section: Section | null
  rateBps: number | null
  baseCents: number
  whtCents: number
  creditNoteWhtCents?: number
  baseDerived?: boolean
}
interface Register {
  from: string
  to: string
  rows: Row[]
  totals: { baseCents: number; whtCents: number; bySection: Record<string, number> }
  note: string
}

const SECTION_LABEL: Record<Section | 'none', string> = {
  '153_1_a': 's.153(1)(a) — goods',
  '153_1_b': 's.153(1)(b) — services',
  '153_1_c': 's.153(1)(c) — contracts',
  '155': 's.155 — rent',
  none: 'No section',
}
const SOURCE_LABEL: Record<Row['source'], string> = { supplier_bill: 'Supplier bill', opex: 'OpEx payment', capex: 'CapEx payment' }
const SOURCE_HREF: Record<Row['source'], string> = { supplier_bill: '/procurement', opex: '/finance/opex', capex: '/finance/capex' }
const FILER_LABEL: Record<string, string> = { filer: 'Filer', non_filer: 'Non-filer', exempt: 'Exempt', unknown: 'Not known' }
const ERROR_TEXT: Record<string, string> = {
  INVALID_DATE: 'Give the dates as day / month / year.',
  BAD_PERIOD: 'The period ends before it starts.',
}
const errText = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return (x?.code && ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

export default function WithholdingRegister({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ['withholding-register', from, to],
    queryFn: () => api.get<Register>(`/accounting/withholding/register?from=${from}&to=${to}`),
  })
  const [csvError, setCsvError] = useState<string | null>(null)

  // A document links to its page only for a login that can open it.
  const { data: me } = usePermissions()
  const canOpen = (path: string) => !!me && canOpenPath(path, me.role, me.modules ?? [])

  const d = q.data
  const showCompany = !!d && new Set(d.rows.map((r) => r.tenantId)).size > 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-s-muted">Income tax withheld from vendors, {from} → {to}. File it with your CA (s.165 statement).</p>
        <ExportMenu path={`/accounting/withholding/register?from=${from}&to=${to}`} filename={`withholding-register-${from}-${to}`} onError={(m) => setCsvError(m)} />
      </div>
      {csvError && <p className="text-s-red text-sm">Export failed: {csvError}</p>}
      {q.isLoading && <p className="text-s-muted text-sm">Loading…</p>}
      {q.isError && <p className="text-s-red text-sm">{errText(q.error)}</p>}
      {d && (
        <>
          <div className="s-card p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div className="flex justify-between gap-3"><span className="text-s-muted">Withheld in the period</span><span className="font-mono font-semibold text-s-text">{fmtPkr(d.totals.whtCents)}</span></div>
            <div className="flex justify-between gap-3"><span className="text-s-muted">On payments / bills of</span><span className="font-mono text-s-text">{fmtPkr(d.totals.baseCents)}</span></div>
            {Object.entries(d.totals.bySection).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 text-xs">
                <span className="text-s-muted">{SECTION_LABEL[k as Section | 'none'] ?? k}</span>
                <span className="font-mono text-s-text">{fmtPkr(v)}</span>
              </div>
            ))}
          </div>

          <div className="s-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    {showCompany && <th className="px-4 py-2 text-left font-medium">Company</th>}
                    <th className="px-4 py-2 text-left font-medium">Document</th>
                    <th className="px-4 py-2 text-left font-medium">Vendor · NTN</th>
                    <th className="px-4 py-2 text-left font-medium">Section · rate</th>
                    <th className="px-4 py-2 text-right font-medium">Base</th>
                    <th className="px-4 py-2 text-right font-medium">Withheld</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={`${r.source}-${r.sourceId}`} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-xs text-s-text whitespace-nowrap">{r.date}</td>
                      {showCompany && <td className="px-4 py-2 text-xs text-s-text">{r.company}</td>}
                      <td className="px-4 py-2 text-xs text-s-text">
                        {canOpen(SOURCE_HREF[r.source])
                          ? <Link href={SOURCE_HREF[r.source]} className="hover:underline">{SOURCE_LABEL[r.source]}</Link>
                          : SOURCE_LABEL[r.source]}
                        <div className="text-s-muted">{r.document}</div>
                      </td>
                      <td className="px-4 py-2 text-xs text-s-text">
                        {r.vendor}
                        <div className="text-s-muted">
                          {r.ntn ? `NTN ${r.ntn}` : 'No NTN on file'}
                          {r.filerStatus && <> · {FILER_LABEL[r.filerStatus] ?? r.filerStatus}</>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-s-text">
                        {r.section ? SECTION_LABEL[r.section] : '—'}
                        <div className="text-s-muted">{r.rateBps == null ? 'rate not stored' : `${r.rateBps / 100}%`}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(r.baseCents)}
                        {r.baseDerived && <div className="text-s-muted font-sans">worked back from the rate</div>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">
                        {fmtPkr(r.whtCents)}
                        {(r.creditNoteWhtCents ?? 0) > 0 && <div className="text-s-muted font-sans font-normal">credit notes reversed {fmtPkr(r.creditNoteWhtCents ?? 0)}</div>}
                      </td>
                    </tr>
                  ))}
                  {d.rows.length === 0 && (
                    <tr><td colSpan={showCompany ? 7 : 6} className="px-4 py-3 text-xs text-s-muted">No income tax withheld in this period.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-s-muted">{d.note}</p>
        </>
      )}
    </div>
  )
}
