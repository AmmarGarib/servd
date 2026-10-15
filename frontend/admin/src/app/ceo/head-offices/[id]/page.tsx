'use client'
// CEO → Head offices → one head office (D1/D3 spec §10). Seven tabs.

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { headOfficeApi, booksStatus } from '../../../../lib/headOfficeApi'
import CompaniesTab from './CompaniesTab'
import SplitTab from './SplitTab'
import BooksTab from './BooksTab'
import RunsTab, { ReconciliationTab } from './RunsTab'
import HandOverTab from './HandOverTab'
import PeopleTab from './PeopleTab'

const TABS = [
  ['companies', 'Companies'], ['split', 'Cost split'], ['books', 'Books'], ['runs', 'Runs'],
  ['reconciliation', 'Reconciliation'], ['handover', 'Hand-over'], ['people', 'People'],
] as const
type TabKey = (typeof TABS)[number][0]

export default function HeadOfficePage() {
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<TabKey>('companies')
  const q = useQuery({ queryKey: ['head-office', id], queryFn: () => headOfficeApi.detail(id), enabled: !!id })
  const reload = () => { void q.refetch() }

  if (q.isLoading) return <Shell><p className="text-sm text-white/40">Loading…</p></Shell>
  if (q.error || !q.data) return <Shell><p className="text-sm text-red-600">This head office was not found.</p></Shell>
  const d = q.data
  const st = booksStatus({ confirmed: d.books?.confirmed ?? false, rechargeEnabled: d.books?.rechargeEnabled ?? false, rechargeFromPeriod: d.books?.rechargeFromPeriod ?? null })

  return (
    <Shell>
      <Link href="/ceo/head-offices" className="text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>Head offices</Link>
      <div className="flex items-center gap-3 flex-wrap mt-1">
        <h1 className="text-2xl font-black text-white/90">{d.headOffice.name}</h1>
        <span className={st.tone === 'green' ? 's-badge-green' : st.tone === 'purple' ? 's-badge-purple' : 's-badge-amber'}>{st.label}</span>
        {!d.headOffice.isActive && <span className="s-badge-muted">Switched off</span>}
        {d.headOffice.isTest && <span className="s-badge-muted">Test</span>}
      </div>
      <div className="mt-4 flex gap-1 overflow-x-auto" style={{ borderBottom: '1px solid var(--border)' }} role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className="px-3 py-2 text-sm font-bold whitespace-nowrap"
            style={tab === k ? { color: 'var(--erp-primary-ink)', borderBottom: '2px solid var(--erp-accent)' } : { color: 'rgb(var(--fg-rgb) / 0.5)', borderBottom: '2px solid transparent' }}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'companies' && <CompaniesTab hoId={id} detail={d} reload={reload} />}
        {tab === 'split' && <SplitTab hoId={id} detail={d} reload={reload} />}
        {tab === 'books' && <BooksTab hoId={id} detail={d} reload={reload} />}
        {tab === 'runs' && <RunsTab detail={d} />}
        {tab === 'reconciliation' && <ReconciliationTab hoId={id} />}
        {tab === 'handover' && <HandOverTab hoId={id} />}
        {tab === 'people' && <PeopleTab hoId={id} detail={d} reload={reload} />}
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="p-4 sm:p-6 max-w-5xl mx-auto">{children}</div>
}
