'use client'
// Dev → API → POS connector (spec §10, §8.1, §17.0, §17.7).
//
// servd is the order-taking software; through this connector it talks to
// (a) the external fiscal POS that files FBR / SRB and (b) the card machine.
// Everything here belongs to the operator's ACTIVE company. The CEO and IT
// configure it; management can read it and retry a document; the CEO alone
// goes live, switches off, releases held sales and sets whether the company
// needs fiscal reporting at all. Only full & final bills are filed — a
// pre-bill never reaches the POS — and no real sale can be skipped.

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../../lib/api'
import { getSocket } from '../../../lib/socket'
import { useAuthStore } from '../../../store/auth'
import { connectorErrorText, useActiveCompany, useConnectorsOverview, type FiscalDocStatus } from '../../../lib/connectorsApi'
import { useViewAllTenants } from '../../../components/ui/TenantSwitcher'
import { Banner, TestBadge } from '../../../components/connectors/ui'
import { PosStatus } from '../../../components/connectors/PosStatus'
import { FiscalSetup } from '../../../components/connectors/FiscalSetup'
import { PosIdsTable } from '../../../components/connectors/PosIdsTable'
import { TerminalSetup } from '../../../components/connectors/TerminalSetup'
import { FiscalSubmissions } from '../../../components/connectors/FiscalSubmissions'
import { TerminalCharges } from '../../../components/connectors/TerminalCharges'

type Tab = 'status' | 'fiscal' | 'posids' | 'terminal' | 'submissions' | 'charges'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'status', label: 'Status' },
  { key: 'fiscal', label: 'Fiscal setup' },
  { key: 'posids', label: 'POS IDs' },
  { key: 'terminal', label: 'Card machine' },
  { key: 'submissions', label: 'Submissions' },
  { key: 'charges', label: 'Card charges' },
]

const CONNECTOR_ADMINS = ['admin', 'it']
const MANAGERS = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager']

export default function PosConnectorPage() {
  return <Suspense fallback={null}><PosConnector /></Suspense>
}

function PosConnector() {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const isCeo = role === 'admin'
  const canEdit = CONNECTOR_ADMINS.includes(role)
  const canManageCharges = MANAGERS.includes(role)
  const company = useActiveCompany()
  const portfolio = useViewAllTenants()
  const { data, error, isLoading } = useConnectorsOverview({ refetchMs: 10_000 })

  const [tab, setTab] = useState<Tab>('status')
  const [docStatus, setDocStatus] = useState<FiscalDocStatus | ''>('')
  // Bumped on every counter click so the same counter re-applies its filter.
  const [docOpen, setDocOpen] = useState<{ status: FiscalDocStatus | ''; day: string; n: number }>({ status: '', day: '', n: 0 })
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    if (t && TABS.some((x) => x.key === t)) setTab(t)
  }, [])
  function go(t: Tab) {
    setTab(t)
    const u = new URL(window.location.href)
    u.searchParams.set('tab', t)
    window.history.replaceState(null, '', u.toString())
  }

  // A document filed in the background refreshes the counts and the list.
  useEffect(() => {
    const sock = getSocket()
    const onFiled = () => {
      void qc.invalidateQueries({ queryKey: ['connectors'] })
      void qc.invalidateQueries({ queryKey: ['fiscal-docs'] })
    }
    sock.on('fiscal.filed', onFiled)
    return () => { sock.off('fiscal.filed', onFiled) }
  }, [qc])

  const companyName = company?.name ?? 'this company'

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/90 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4">
        <Link href="/connectors" className="text-xs text-s-muted hover:text-s-text">← API</Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-s-text">POS connector</h1>
          {data?.fiscal.isTest && <TestBadge />}
        </div>
        <p className="text-xs text-s-muted mt-1">
          The fiscal POS that files FBR / SRB, and the card machine — for <strong className="text-s-text">{companyName}</strong>.
          {portfolio && ' This page (settings, counts, Submissions, Card charges and “needs a person”) shows the ACTIVE company only — switch company to see another company’s outbox.'}
        </p>
        <nav className="mt-3 -mb-4 flex gap-1 overflow-x-auto" aria-label="POS connector sections">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => go(t.key)}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.key ? 'border-primary font-semibold text-s-text' : 'border-transparent text-s-muted hover:text-s-text'}`}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 sm:px-6 py-6">
        {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
        {error && (
          <Banner tone="bad" title={error instanceof ApiError && error.status === 403 ? 'Your role cannot open the POS connector' : 'Could not load the POS connector'}>
            <p>{connectorErrorText(error)}</p>
          </Banner>
        )}

        {data && (
          <>
            {!data.fiscalReportingRequired && (
              <Banner tone="warn" title={`Fiscal reporting: not required for ${companyName} (non-commercial / test)`}>
                <p>This company&rsquo;s sales are not filed with FBR / SRB and its receipts print &ldquo;Not a tax invoice&rdquo;. The card machine still works. Only the CEO can change this, in Fiscal setup.</p>
                {data.heldNote && <p className="mt-1">{data.heldNote}</p>}
              </Banner>
            )}
            {data.fiscalReportingRequired && !data.fiscal.enabled && (
              <Banner tone={data.fiscal.liveSince ? 'bad' : 'warn'} title={data.fiscal.liveSince ? 'The fiscal POS is switched off — new sales are held' : 'Not live yet — every sale is held, nothing is filed'}>
                <p>
                  {data.counts.held} held so far. Held sales are never sent on their own: the CEO goes live, then releases them all (no date range, no skipping).
                </p>
              </Banner>
            )}
            {data.fiscalReportingRequired && data.fiscal.enabled && data.fiscal.isTest && (
              <Banner tone="warn" title="TEST mode — the built-in test driver is filing">
                <p>Numbers it returns are not real fiscal invoices. Switch to the vendor&rsquo;s driver before trading.</p>
              </Banner>
            )}
            {data.terminal.enabled && data.terminal.driver === 'test' && (
              <Banner tone="bad" title="TEST card machine is ON at the till — card sales are recorded as paid but no card is charged">
                <p>The built-in test driver approves charges without any money moving. Switch it off or pick the processor&rsquo;s driver in Card machine before trading.</p>
              </Banner>
            )}

            {tab === 'status' && (
              <PosStatus data={data} canManageCharges={canManageCharges}
                onOpenSubmissions={(s, opts) => { setDocStatus(s); setDocOpen((p) => ({ status: s, day: opts?.today ? todayPk() : '', n: p.n + 1 })); go('submissions') }} />
            )}
            {tab === 'fiscal' && <FiscalSetup data={data} companyName={companyName} canEdit={canEdit} isCeo={isCeo} />}
            {tab === 'posids' && <PosIdsTable data={data} canEdit={canEdit} activeTenantId={company?.id ?? null} />}
            {tab === 'terminal' && <TerminalSetup data={data} canEdit={canEdit} activeTenantId={company?.id ?? null} />}
            {tab === 'submissions' && <FiscalSubmissions key={docOpen.n} data={data} initialStatus={docStatus} initialDay={docOpen.day} canConfigure={canEdit} portfolio={portfolio} />}
            {tab === 'charges' && <TerminalCharges data={data} canConfigure={canEdit} portfolio={portfolio} />}
          </>
        )}
      </main>
    </div>
  )
}

/** Today's date (YYYY-MM-DD) in Pakistan time, for the "Filed today" counter. */
function todayPk(): string {
  return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
}
