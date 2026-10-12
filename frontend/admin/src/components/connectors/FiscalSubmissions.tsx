'use client'
// POS connector → Submissions tab (spec §10): every fiscal document of the
// ACTIVE company (the connector is one company's), with filters, a drawer (payload + the attempts log) and
// the only operator actions there are: Retry, Record manual filing (a number
// filed out of band, with who/when kept server-side) and Retry all failed.
// There is NO skip (§17.0) — a real sale is never excluded from filing.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AUTHORITIES, DOC_STATUS_LABEL, FISCAL_DOC_STATUSES, authorityLabel, connectorsApi, connectorErrorText,
  docReasonLabel, isTotalsMismatch, mismatchAdvice, retryErrorText,
  type Authority, type ConnectorsOverview, type FiscalDocRow, type FiscalDocStatus,
} from '../../lib/connectorsApi'
import { fmtPkr } from '../../lib/money'
import { canOpenPath } from '../../lib/moduleCatalog'
import { usePermissions } from '../../hooks/useCan'
import { Badge, Banner, Card, DocChip, ErrorLine, Field, Modal, OkLine, fmtWhen } from './ui'

const RETRYABLE: FiscalDocStatus[] = ['failed', 'rejected', 'pending']
const MANUAL_FILABLE: FiscalDocStatus[] = ['held', 'waiting', 'pending', 'failed', 'rejected', 'manual_required']

const dayStart = (d: string) => (d ? `${d}T00:00:00+05:00` : undefined)
const dayEnd = (d: string) => (d ? `${d}T23:59:59.999+05:00` : undefined)

export function FiscalSubmissions({ data, initialStatus, initialDay = '', canConfigure, portfolio = false }: {
  data: ConnectorsOverview
  initialStatus: FiscalDocStatus | ''
  /** YYYY-MM-DD — opens the list on that one day (the "Filed today" counter). */
  initialDay?: string
  /**
   * All-companies view. GET /connectors/fiscal/documents still returns the
   * ACTIVE company's documents only (the API binds it to that company), so
   * this only shows a banner saying so.
   */
  portfolio?: boolean
  /** CEO + IT: manual filing and "Retry all failed". Management may retry one document. */
  canConfigure: boolean
}) {
  const qc = useQueryClient()
  // IT holds api_pos but not orders: the order ref is a link only for a login
  // that can open /orders (the page guard and the API would refuse it).
  const { data: me } = usePermissions()
  const canOpenOrders = !!me && canOpenPath('/orders', me.role, me.modules ?? [])
  const [status, setStatus] = useState<FiscalDocStatus | ''>(initialStatus)
  useEffect(() => { setStatus(initialStatus) }, [initialStatus])
  const [kind, setKind] = useState<'' | 'sale' | 'refund'>('')
  const [from, setFrom] = useState(initialDay)
  const [to, setTo] = useState(initialDay)
  const [conceptId, setConceptId] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t) }, [search])
  const [open, setOpen] = useState<string | null>(null)
  const [manualFor, setManualFor] = useState<FiscalDocRow | null>(null)

  const filters = { status: status || undefined, kind: kind || undefined, from: dayStart(from), to: dayEnd(to), conceptId: conceptId || undefined, q: q || undefined }
  const docs = useInfiniteQuery({
    queryKey: ['fiscal-docs', filters],
    queryFn: ({ pageParam }) => connectorsApi.documents({ ...filters, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  })
  const rows = docs.data?.pages.flatMap((p) => p.items) ?? []

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['fiscal-docs'] }); void qc.invalidateQueries({ queryKey: ['connectors'] }) }
  const retry = useMutation({ mutationFn: (id: string) => connectorsApi.retry(id), onSuccess: refresh })
  const retryAll = useMutation({ mutationFn: connectorsApi.retryAllFailed, onSuccess: refresh })

  return (
    <div className="space-y-4">
      <Card title="Submissions" subtitle="Every sale and refund sent (or waiting to be sent) to the fiscal POS. Pre-bills never appear here."
        actions={canConfigure ? (
          <button className="s-btn-secondary text-xs" disabled={retryAll.isPending || data.counts.failed + data.counts.rejected === 0}
            onClick={() => { if (confirm('Retry every failed and rejected document of this company?')) retryAll.mutate() }}>
            {retryAll.isPending ? 'Retrying…' : 'Retry all failed'}
          </button>
        ) : undefined}>
        {retryAll.data && <OkLine>Queued {retryAll.data.count} document(s) again.</OkLine>}
        <ErrorLine>{retryAll.error ? connectorErrorText(retryAll.error) : null}</ErrorLine>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Field label="Status">
            <select className="s-select text-xs" value={status} onChange={(e) => setStatus(e.target.value as FiscalDocStatus | '')}>
              <option value="">All</option>
              {FISCAL_DOC_STATUSES.map((s) => <option key={s} value={s}>{DOC_STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="Kind">
            <select className="s-select text-xs" value={kind} onChange={(e) => setKind(e.target.value as '' | 'sale' | 'refund')}>
              <option value="">Sales and refunds</option>
              <option value="sale">Sales</option>
              <option value="refund">Refunds</option>
            </select>
          </Field>
          <Field label="Brand">
            <select className="s-select text-xs" value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
              <option value="">All brands</option>
              {data.brandPosIds.map((b) => <option key={b.conceptId} value={b.conceptId}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="From"><input type="date" className="s-input text-xs" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" className="s-input text-xs" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Search"><input className="s-input text-xs" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order ref or fiscal no." /></Field>
        </div>
      </Card>

      {rows.some(isTotalsMismatch) && (
        <Banner tone="bad" title="Some documents were not sent because their figures do not add up">
          <p>
            servd never files numbers that do not add up (lines + tax + service + tip + delivery must equal the bill). Each one is marked
            &ldquo;Figures do not add up&rdquo; below and is in the Inbox. For a sale, check the order&rsquo;s stored figures, then Retry (the sale is
            rebuilt from the order); if it still does not add up, file it on the authority portal and use Record manual filing. A refund is not
            rebuilt, so Retry will not fix it — file it by hand and record it. If a row says an earlier send&rsquo;s result is unknown, the fiscal POS
            may already have it: ask the vendor first, and do not file it by hand until they confirm they never got it.
          </p>
        </Banner>
      )}

      {portfolio && (
        <Banner tone="info" title="All-companies view — this list shows the active company only">
          <p>Switch company to see another company&rsquo;s submissions.</p>
        </Banner>
      )}

      <div className="s-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="s-table">
            <thead>
              <tr><th>Time</th><th>Order</th><th>Brand</th><th>Kind</th><th>Amount</th><th>Status</th><th>Fiscal no.</th><th>Attempts</th><th>Last error</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                  <td className="text-xs">{fmtWhen(r.createdAt)}</td>
                  <td>{canOpenOrders
                    ? <Link href={`/orders/${r.orderId}`} className="font-mono text-xs text-primary-ink underline" onClick={(e) => e.stopPropagation()}>{r.orderRef}</Link>
                    : <span className="font-mono text-xs">{r.orderRef}</span>}</td>
                  <td className="text-xs">{r.brand ?? '—'}</td>
                  <td className="text-xs">{r.kind === 'sale' ? 'Sale' : 'Refund'}</td>
                  <td className="text-xs">{fmtPkr(r.amountCents)}</td>
                  <td>
                    <DocChip status={r.status} isTest={r.isTest} />
                    {isTotalsMismatch(r)
                      ? <span className="mt-1 block"><Badge tone="bad" title={mismatchAdvice(r)?.steps}>Figures do not add up — not sent</Badge></span>
                      : r.statusReason && <span className="block text-[10px] text-s-muted">{docReasonLabel(r.statusReason)}</span>}
                  </td>
                  <td className="font-mono text-xs">{r.fiscalNumber ? `${authorityLabel(r.authority)} ${r.fiscalNumber}` : '—'}</td>
                  <td className="text-xs">{r.attempts}</td>
                  <td className="max-w-[240px] whitespace-normal text-[11px] text-s-red">
                    {r.lastError ?? ''}
                    {isTotalsMismatch(r) && <span className="block mt-1 text-s-text">{mismatchAdvice(r)?.steps}</span>}
                  </td>
                  <td className="text-right space-x-1" onClick={(e) => e.stopPropagation()}>
                    {RETRYABLE.includes(r.status) && (
                      <button className="s-btn-secondary px-2 py-1 text-xs" disabled={retry.isPending} onClick={() => retry.mutate(r.id)}>Retry</button>
                    )}
                    {canConfigure && MANUAL_FILABLE.includes(r.status) && (
                      <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setManualFor(r)}>Record manual filing</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {docs.isLoading && <p className="p-4 text-xs text-s-muted">Loading…</p>}
        {!docs.isLoading && rows.length === 0 && !docs.error && <p className="p-4 text-xs text-s-muted">No documents match.</p>}
        <div className="p-3"><ErrorLine>{docs.error ? connectorErrorText(docs.error) : retry.error ? retryErrorText(retry.error, rows.find((r) => r.id === retry.variables)) : null}</ErrorLine></div>
        {docs.hasNextPage && (
          <div className="p-3 border-t border-s-border">
            <button className="s-btn-secondary text-xs" disabled={docs.isFetchingNextPage} onClick={() => void docs.fetchNextPage()}>
              {docs.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {open && <DocDrawer id={open} onClose={() => setOpen(null)} canConfigure={canConfigure} canOpenOrders={canOpenOrders} onManual={(r) => { setOpen(null); setManualFor(r) }} />}
      {manualFor && <ManualFilingDialog doc={manualFor} onClose={() => setManualFor(null)} onDone={refresh} />}
    </div>
  )
}

function DocDrawer({ id, onClose, canConfigure, canOpenOrders, onManual }: { id: string; onClose: () => void; canConfigure: boolean; canOpenOrders: boolean; onManual: (r: FiscalDocRow) => void }) {
  const qc = useQueryClient()
  const d = useQuery({ queryKey: ['fiscal-doc', id], queryFn: () => connectorsApi.document(id) })
  const retry = useMutation({
    mutationFn: () => connectorsApi.retry(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fiscal-doc', id] }); void qc.invalidateQueries({ queryKey: ['fiscal-docs'] }); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const doc = d.data
  return (
    <Modal wide title={doc ? `${doc.kind === 'sale' ? 'Sale' : 'Refund'} ${doc.orderRef}` : 'Fiscal document'} onClose={onClose}>
      {d.isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      <ErrorLine>{d.error ? connectorErrorText(d.error) : null}</ErrorLine>
      {doc && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <DocChip status={doc.status} isTest={doc.isTest} />
            {doc.statusReason && <span className="text-xs text-s-muted">{docReasonLabel(doc.statusReason)}</span>}
          </div>
          {(() => {
            const advice = mismatchAdvice(doc)
            return advice && (
              <Banner tone="bad" title={advice.title}>
                <p>{advice.steps}</p>
              </Banner>
            )
          })()}
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <div><dt className="text-s-muted">Amount</dt><dd>{fmtPkr(doc.amountCents)}</dd></div>
            <div><dt className="text-s-muted">Fiscal no.</dt><dd className="font-mono">{doc.fiscalNumber ? `${authorityLabel(doc.authority)} ${doc.fiscalNumber}` : '—'}</dd></div>
            <div><dt className="text-s-muted">Filed</dt><dd>{fmtWhen(doc.filedAt)}</dd></div>
            <div><dt className="text-s-muted">Created</dt><dd>{fmtWhen(doc.createdAt)}</dd></div>
            <div><dt className="text-s-muted">Next attempt</dt><dd>{fmtWhen(doc.nextAttemptAt)}</dd></div>
            <div><dt className="text-s-muted">Driver</dt><dd className="font-mono">{doc.driver ?? '—'}</dd></div>
            <div className="col-span-2 sm:col-span-3"><dt className="text-s-muted">Order</dt><dd>{canOpenOrders
              ? <Link href={`/orders/${doc.orderId}`} className="text-primary-ink underline">Open order {doc.orderRef}</Link>
              : <span className="font-mono">{doc.orderRef}</span>}</dd></div>
            {doc.lastError && <div className="col-span-2 sm:col-span-3"><dt className="text-s-muted">Last error</dt><dd className="text-s-red break-words">{doc.lastErrorCode ? `${doc.lastErrorCode}: ` : ''}{doc.lastError}</dd></div>}
          </dl>
          <div className="flex flex-wrap gap-2">
            {RETRYABLE.includes(doc.status) && <button className="s-btn-secondary text-xs" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Retrying…' : 'Retry'}</button>}
            {canConfigure && MANUAL_FILABLE.includes(doc.status) && <button className="s-btn-ghost text-xs" onClick={() => onManual({ ...doc, brand: null })}>Record manual filing</button>}
          </div>
          <ErrorLine>{retry.error ? retryErrorText(retry.error, doc) : null}</ErrorLine>

          <div>
            <h4 className="text-xs font-bold text-s-text mb-1">Attempts (latest 50)</h4>
            {doc.attemptsLog.length === 0 ? <p className="text-xs text-s-muted">None yet.</p> : (
              <div className="overflow-x-auto">
                <table className="s-table">
                  <thead><tr><th>When</th><th>#</th><th>Op</th><th>Outcome</th><th>Via</th><th>ms</th><th>Message</th></tr></thead>
                  <tbody>
                    {doc.attemptsLog.map((a) => (
                      <tr key={a.id}>
                        <td className="text-xs">{fmtWhen(a.createdAt)}</td>
                        <td className="text-xs">{a.attemptNo}</td>
                        <td className="text-xs">{a.op}</td>
                        <td className="text-xs">{a.outcome}{a.httpStatus ? ` (${a.httpStatus})` : ''}</td>
                        <td className="text-xs">{a.via.replace(/_/g, ' ')}</td>
                        <td className="text-xs">{a.durationMs}</td>
                        <td className="max-w-[260px] whitespace-normal text-[11px] text-s-muted">{a.errorCode ? `${a.errorCode}: ` : ''}{a.message ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h4 className="text-xs font-bold text-s-text mb-1">Payload sent</h4>
            <pre className="max-h-[320px] overflow-auto rounded-lg bg-s-bg p-3 text-[11px] text-s-text">{JSON.stringify(doc.payload, null, 2)}</pre>
          </div>
        </>
      )}
    </Modal>
  )
}

function ManualFilingDialog({ doc, onClose, onDone }: { doc: FiscalDocRow; onClose: () => void; onDone: () => void }) {
  const [fiscalNumber, setFiscalNumber] = useState('')
  const [authority, setAuthority] = useState<Authority>((AUTHORITIES as string[]).includes(doc.authority ?? '') ? (doc.authority as Authority) : 'srb')
  const [verifyUrl, setVerifyUrl] = useState('')
  const [qrPayload, setQrPayload] = useState('')
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => connectorsApi.recordManual(doc.id, {
      fiscalNumber: fiscalNumber.trim(), authority,
      ...(verifyUrl.trim() && { verifyUrl: verifyUrl.trim() }),
      ...(qrPayload.trim() && { qrPayload: qrPayload.trim() }),
      ...(note.trim() && { note: note.trim() }),
    }),
    onSuccess: () => { onDone(); onClose() },
  })
  return (
    <Modal title={`Record manual filing — ${doc.kind === 'sale' ? 'sale' : 'refund'} ${doc.orderRef}`} onClose={onClose}>
      <p className="text-xs text-s-muted">
        Only for a document already filed outside servd (for example on the authority&rsquo;s portal). Who recorded it, and when, is kept in the audit log.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Fiscal invoice number"><input className="s-input font-mono" value={fiscalNumber} onChange={(e) => setFiscalNumber(e.target.value)} maxLength={64} /></Field>
        <Field label="Authority">
          <select className="s-select" value={authority} onChange={(e) => setAuthority(e.target.value as Authority)}>
            {AUTHORITIES.map((a) => <option key={a} value={a}>{authorityLabel(a)}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Verify link (optional)"><input className="s-input text-xs" value={verifyUrl} onChange={(e) => setVerifyUrl(e.target.value)} placeholder="https://…" /></Field>
      <Field label="QR text (optional)"><input className="s-input text-xs" value={qrPayload} onChange={(e) => setQrPayload(e.target.value)} maxLength={1000} /></Field>
      <Field label="Note (optional)"><input className="s-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
      <div className="flex justify-end gap-2">
        <button className="s-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="s-btn-primary" disabled={!fiscalNumber.trim() || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Record'}</button>
      </div>
    </Modal>
  )
}
