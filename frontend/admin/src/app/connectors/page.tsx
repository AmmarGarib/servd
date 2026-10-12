'use client'
// Dev → API (spec §10, D13). The admin "API" section holds exactly two
// connectors: the WhatsApp gateway (one platform-wide gateway for every
// company) and the POS connector (per company: the fiscal POS that files
// FBR / SRB, the card machine and Raast QR bank alerts). Not under /api/* — the admin rewrites
// /api/:path* to the backend.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import { connectorErrorText, connectorsApi, useActiveCompany, useConnectorsOverview } from '../../lib/connectorsApi'
import { Badge, Dot, TestBadge, fmtAge, fmtWhen } from '../../components/connectors/ui'
import { fiscalHealth, fiscalMode } from '../../components/connectors/PosStatus'

export default function ConnectorsHub() {
  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-4 sm:px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">API</h1>
        <p className="text-xs text-s-muted mt-1">The two systems servd talks to: the WhatsApp gateway and the POS connector.</p>
      </header>
      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 px-4 sm:px-6 py-6 md:grid-cols-2">
        <WhatsappCard />
        <PosCard />
      </main>
    </div>
  )
}

function denied(err: unknown) {
  return err instanceof ApiError && err.status === 403
}

function WhatsappCard() {
  const wa = useQuery({ queryKey: ['whatsapp-config'], queryFn: connectorsApi.whatsapp, retry: false })
  const ds = useQuery({ queryKey: ['delivery-status'], queryFn: connectorsApi.deliveryStatus, retry: false, refetchInterval: 60_000 })
  return (
    <Link href="/connectors/whatsapp" className="s-card-hover block p-5 space-y-3">
      <div>
        <h2 className="text-base font-bold text-s-text">WhatsApp connector</h2>
        <p className="text-xs text-s-muted">Hasham&rsquo;s gateway — OTPs, staff codes, order messages. Platform-wide: one gateway for every company.</p>
      </div>
      {wa.isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      {wa.error && <p className="text-xs text-s-muted">{denied(wa.error) ? 'Open to the CEO and IT.' : connectorErrorText(wa.error)}</p>}
      {wa.data && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={wa.data.configured ? 'ok' : 'bad'}>{wa.data.configured ? 'Configured' : 'Not configured — signup is down'}</Badge>
          <span className="text-xs text-s-muted">
            {wa.data.source === 'database' ? 'Set in admin' : wa.data.source === 'environment' ? 'From the server environment' : 'No endpoint anywhere'}
          </span>
        </div>
      )}
      {ds.data && (
        <div className="text-xs">
          <Dot tone={ds.data.ok ? 'ok' : 'bad'} label={ds.data.ok ? 'Codes are sending' : 'Delivery problem'} />
          {!ds.data.ok && <p className="mt-1 text-s-text">{ds.data.detail}</p>}
          <p className="mt-1 text-s-muted">Delivery check {ds.data.checkedAt ? `${fmtAge(ds.data.checkedAt)} ago` : 'not run yet'}.</p>
        </div>
      )}
      <p className="text-xs font-semibold text-primary-ink">Open →</p>
    </Link>
  )
}

function PosCard() {
  const company = useActiveCompany()
  const { data, error, isLoading } = useConnectorsOverview({ refetchMs: 30_000 })
  const backlog = data ? [
    { label: 'Held', n: data.counts.held },
    { label: 'Pending', n: data.counts.pending },
    { label: 'Failed', n: data.counts.failed + data.counts.rejected },
    { label: 'File by hand', n: data.counts.manualRequired },
    { label: 'Filed today', n: data.counts.filedToday },
  ] : []
  const mode = data ? fiscalMode(data) : null
  const health = data ? fiscalHealth(data) : null
  return (
    <Link href="/connectors/pos" className="s-card-hover block p-5 space-y-3">
      <div>
        <h2 className="text-base font-bold text-s-text">POS connector</h2>
        <p className="text-xs text-s-muted">Fiscal POS (FBR / SRB), card machine and Raast QR bank alerts{company ? ` — ${company.name}` : ''}.</p>
      </div>
      {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      {error && <p className="text-xs text-s-muted">{denied(error) ? 'Open to the CEO, IT and management.' : connectorErrorText(error)}</p>}
      {data && mode && health && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-s-muted">Fiscal:</span>
            <Badge tone={mode.tone}>{data.fiscalReportingRequired ? (data.fiscal.enabled ? 'Live' : 'Off') : 'Not required'}</Badge>
            {mode.test && <TestBadge />}
            <Dot tone={health.tone} label={health.label} />
          </div>
          {data.fiscal.enabled && data.fiscal.liveSince && <p className="text-xs text-s-muted">Live since {fmtWhen(data.fiscal.liveSince)}.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-s-muted">Card machine:</span>
            <Badge tone={data.terminal.enabled ? 'ok' : 'muted'}>{data.terminal.enabled ? 'On at the till' : 'Off'}</Badge>
            {data.terminal.isTest && <TestBadge />}
            {data.terminalAttention > 0 && <Badge tone="bad">{data.terminalAttention} need attention</Badge>}
          </div>
          {data.terminal.enabled && data.terminal.driver === 'test' && (
            <p role="alert" className="rounded-lg border border-s-red/40 bg-s-red-dim px-3 py-2 text-xs font-semibold text-s-red">
              TEST card machine is on at the till — card sales are recorded as paid but no card is charged.
            </p>
          )}
          {!data.fiscalReportingRequired && data.counts.held > 0 && (
            <p className="text-xs text-s-muted">{data.counts.held} sale{data.counts.held === 1 ? '' : 's'} held from before reporting was switched off — kept, never skipped.</p>
          )}
          {data.fiscalReportingRequired && (
            <div className="grid grid-cols-5 gap-1 text-center">
              {backlog.map((b) => (
                <div key={b.label} className="rounded-lg bg-s-bg px-1 py-2">
                  <p className="text-base font-bold text-s-text">{b.n}</p>
                  <p className="text-[10px] leading-tight text-s-muted">{b.label}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <p className="text-xs font-semibold text-primary-ink">Open →</p>
    </Link>
  )
}
