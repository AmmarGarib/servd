'use client'
// POS connector → Change requests tab (head office D1/D3, spec §8.3).
//
// IT prepares a change to this company's fiscal POS or card machine; the CEO
// (or a live Dev hand-over) approves it and it is applied in one step. Backend:
// modules/connectors/changeRequests.ts. The API key and webhook secret are typed
// ONCE here: the server seals them and never returns them (the list shows only
// "new key set" / "key cleared"). Going live, switching off, "Fiscal reporting
// required" and releasing held sales are not requestable — they stay the CEO's
// own buttons on the Fiscal setup tab.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  connectorsApi, connectorErrorText, useDrivers,
  type ChangeRequestBody, type ChangeRequestStatus, type ConnectorChangeRequest, type ConnectorKind, type ConnectorsOverview,
} from '../../../lib/connectorsApi'
import { useHeadOfficeMe } from '../../../hooks/useWorkspaces'
import { useAuthStore } from '../../../store/auth'
import { Badge, Card, ErrorLine, Field, OkLine, fmtWhen, type Tone } from '../../../components/connectors/ui'
import { Select } from '@/components/ui/Select'

const STATUS: Record<ChangeRequestStatus, { tone: Tone; label: string }> = {
  submitted: { tone: 'warn', label: 'Waiting for approval' },
  applied: { tone: 'ok', label: 'Applied' },
  rejected: { tone: 'bad', label: 'Rejected' },
  withdrawn: { tone: 'muted', label: 'Withdrawn' },
}
const KIND_LABEL: Record<ConnectorKind, string> = { fiscal: 'Fiscal POS', terminal: 'Card machine' }

/** A plain-words list of what a request changes (never a secret's value). */
function describe(c: ConnectorChangeRequest): string[] {
  const p = c.patch
  const out: string[] = []
  if (p.driver !== undefined) out.push(`Driver: ${p.driver}`)
  if (p.baseUrl !== undefined) out.push(p.baseUrl ? `Address: ${p.baseUrl}` : 'Address cleared')
  if (p.apiKey) out.push(p.apiKey === 'set' ? 'New API key (sealed, not shown)' : 'API key cleared')
  if (p.webhookSecret) out.push(p.webhookSecret === 'set' ? 'New webhook secret (sealed, not shown)' : 'Webhook secret cleared')
  if (p.enabled !== undefined) out.push(p.enabled ? 'Switch the card machine on' : 'Switch the card machine off')
  if (p.settings) for (const [k, v] of Object.entries(p.settings)) out.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  return out
}

export function ChangeRequests({ data, companyName, canSend, isCeo, activeTenantId }: {
  data: ConnectorsOverview
  companyName: string
  /** CONNECTOR_ADMINS (CEO, IT): may send a request. */
  canSend: boolean
  isCeo: boolean
  activeTenantId: string | null
}) {
  const qc = useQueryClient()
  const { delegations } = useHeadOfficeMe()
  const userId = useAuthStore((s) => s.user?.id ?? '')
  // The server decides; a Dev hand-over holder (connector_change is a Dev-section
  // right) gets the buttons too — not a Finance / HR / Marketing delegate.
  const canDecide = isCeo || delegations.some((d) => d.section === 'dev')
  const [status, setStatus] = useState<'' | ChangeRequestStatus>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showForm, setShowForm] = useState(false)

  const list = useQuery({
    queryKey: ['connectors', 'change-requests', status],
    queryFn: () => connectorsApi.changeRequests({ ...(status && { status }), limit: 100 }),
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['connectors'] })
  }
  const changes = list.data?.changes ?? []

  return (
    <div className="space-y-4">
      <Card
        title="Change requests"
        subtitle={`IT proposes a change to ${companyName}'s POS settings; the CEO approves it and it is applied at once. Secrets are typed once and never shown again.`}
        actions={canSend && !showForm ? <button type="button" className="s-btn-primary text-sm" onClick={() => setShowForm(true)}>Send change for approval</button> : undefined}
      >
        {msg && (
          <div className="flex items-start justify-between gap-3">
            {msg.ok ? <OkLine>{msg.text}</OkLine> : <ErrorLine>{msg.text}</ErrorLine>}
            <button type="button" className="text-xs text-s-muted hover:text-s-text" onClick={() => setMsg(null)}>Close</button>
          </div>
        )}
        {showForm && canSend && (
          <RequestForm
            data={data}
            companyName={companyName}
            activeTenantId={activeTenantId}
            onDone={() => { setShowForm(false); setMsg({ ok: true, text: 'Sent for approval. Nothing changes until it is approved.' }); refresh() }}
            onCancel={() => setShowForm(false)}
          />
        )}
      </Card>

      <div className="flex items-end gap-3">
        <Field label="Show" htmlFor="cr-status">
          <Select id="cr-status" value={status} onChange={(e) => setStatus(e.target.value as '' | ChangeRequestStatus)} className="s-select py-1.5">
            <option value="">All requests</option>
            {(Object.keys(STATUS) as ChangeRequestStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
          </Select>
        </Field>
      </div>

      {list.isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      {list.isError && <ErrorLine>{connectorErrorText(list.error)}</ErrorLine>}
      {!list.isLoading && !list.isError && changes.length === 0 && (
        <p className="s-card p-6 text-center text-sm text-s-muted">No change requests{status ? ' with this status' : ' yet'}.</p>
      )}
      <ul className="space-y-2">
        {changes.map((c) => (
          <RequestRow key={c.id} c={c} canDecide={canDecide} userId={userId} onDone={(text) => { setMsg({ ok: true, text }); refresh() }} onError={(e) => setMsg({ ok: false, text: connectorErrorText(e) })} />
        ))}
      </ul>
    </div>
  )
}

function RequestRow({ c, canDecide, userId, onDone, onError }: {
  c: ConnectorChangeRequest
  canDecide: boolean
  /** The signed-in login: only the preparer may withdraw (server: NOT_PREPARER). */
  userId: string
  onDone: (text: string) => void
  onError: (e: unknown) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const st = STATUS[c.status]
  const act = useMutation({
    mutationFn: async (a: 'approve' | 'reject' | 'withdraw'): Promise<void> => {
      if (a === 'approve') await connectorsApi.approveChangeRequest(c.id, c.tenantId)
      else if (a === 'reject') await connectorsApi.rejectChangeRequest(c.id, note.trim(), c.tenantId)
      else await connectorsApi.withdrawChangeRequest(c.id, c.tenantId)
    },
    onSuccess: (_r, a) => {
      setRejecting(false); setNote('')
      onDone(a === 'approve' ? 'Approved — the change is applied.' : a === 'reject' ? 'Rejected.' : 'Withdrawn.')
    },
    onError,
  })
  const items = describe(c)
  const mine = !!userId && (c.preparedById === userId || (c.preparedByIds ?? []).includes(userId))
  return (
    <li className="s-card p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        <Badge tone="info">{KIND_LABEL[c.kind] ?? c.kind}</Badge>
        {c.viaHeadOfficeId && <Badge tone="muted">Via head office</Badge>}
        <span className="text-xs text-s-muted">Prepared by {c.preparedByName ?? '—'} · {fmtWhen(c.preparedAt)}</span>
      </div>
      <ul className="text-sm text-s-text list-disc pl-5">
        {items.length === 0 ? <li>No visible changes</li> : items.map((t) => <li key={t}>{t}</li>)}
      </ul>
      {c.decidedAt && c.status !== 'submitted' && (
        <p className="text-xs text-s-muted">
          {c.status === 'withdrawn' ? 'Withdrawn' : c.status === 'rejected' ? 'Rejected' : 'Applied'} {fmtWhen(c.decidedAt)}
          {c.decisionNote && <> — “{c.decisionNote}”</>}
        </p>
      )}
      {c.status === 'submitted' && (
        <div className="flex flex-wrap items-end gap-2">
          {!rejecting && canDecide && (
            <>
              <button type="button" className="s-btn-primary text-sm" disabled={act.isPending}
                onClick={() => { if (window.confirm('Approve and apply this change now?')) act.mutate('approve') }}>
                {act.isPending ? 'Working…' : 'Approve and apply'}
              </button>
              <button type="button" className="s-btn-secondary text-sm" onClick={() => setRejecting(true)}>Reject</button>
            </>
          )}
          {!rejecting && mine && (
            <button type="button" className="s-btn-ghost text-sm" disabled={act.isPending}
              onClick={() => { if (window.confirm('Withdraw this request? Only the person who sent it can.')) act.mutate('withdraw') }}>
              Withdraw
            </button>
          )}
          {rejecting && (
            <>
              <label className="block min-w-[14rem] flex-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-s-muted mb-1">Why is it rejected?</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="s-input py-1.5" />
              </label>
              <button type="button" className="s-btn-secondary text-sm" disabled={act.isPending || note.trim().length < 1} onClick={() => act.mutate('reject')}>Reject request</button>
              <button type="button" className="s-btn-ghost text-sm" onClick={() => { setRejecting(false); setNote('') }}>Cancel</button>
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** The request form. Blank = leave as it is; secrets are write-only and cleared as soon as the request is sent. */
function RequestForm({ data, companyName, activeTenantId, onDone, onCancel }: {
  data: ConnectorsOverview
  companyName: string
  activeTenantId: string | null
  onDone: () => void
  onCancel: () => void
}) {
  const drivers = useDrivers()
  const [kind, setKind] = useState<ConnectorKind>('fiscal')
  const [driver, setDriver] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [clearSecret, setClearSecret] = useState(false)
  const [enabled, setEnabled] = useState<'' | 'on' | 'off'>('')
  const [timeout, setTimeoutV] = useState('')
  const [err, setErr] = useState('')

  const current = kind === 'fiscal' ? data.fiscal : data.terminal
  const kindDrivers = (drivers.data ?? []).filter((d) => d.kind === kind)
  const timeoutKey = kind === 'fiscal' ? 'syncTimeoutMs' : 'chargeTimeoutSec'

  const build = (): ChangeRequestBody => {
    const b: ChangeRequestBody = {}
    if (driver && driver !== current.driver) b.driver = driver
    if (baseUrl.trim() && baseUrl.trim() !== (current.baseUrl ?? '')) b.baseUrl = baseUrl.trim()
    if (apiKey.trim()) b.apiKey = apiKey.trim()
    else if (clearKey) b.apiKey = ''
    if (webhookSecret.trim()) b.webhookSecret = webhookSecret.trim()
    else if (clearSecret) b.webhookSecret = ''
    if (kind === 'terminal' && enabled) b.enabled = enabled === 'on'
    const n = Number(timeout)
    if (timeout.trim() && Number.isFinite(n) && n > 0) b.settings = { [timeoutKey]: Math.round(n) }
    return b
  }
  const body = build()
  const nothing = Object.keys(body).length === 0

  const send = useMutation({
    mutationFn: () => connectorsApi.sendChangeRequest(kind, body),
    onSuccess: () => { setApiKey(''); setWebhookSecret(''); onDone() },
    onError: (e) => { setApiKey(''); setWebhookSecret(''); setErr(connectorErrorText(e)) },
  })

  return (
    <form className="space-y-3 border-t border-s-border pt-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); setErr(''); if (!nothing) send.mutate() }}>
      <p className="text-xs text-s-muted">
        A request for <strong className="text-s-text">{companyName}</strong>{activeTenantId ? '' : ' (pick a company first)'}. Leave a field blank to keep it as it is.
        Going live and switching the fiscal POS off are the CEO&rsquo;s own buttons — they cannot be requested.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What to change" htmlFor="cr-kind">
          <Select id="cr-kind" value={kind} onChange={(e) => { setKind(e.target.value as ConnectorKind); setDriver(''); setEnabled('') }} className="s-select py-1.5">
            <option value="fiscal">Fiscal POS</option>
            <option value="terminal">Card machine</option>
          </Select>
        </Field>
        <Field label="Driver" htmlFor="cr-driver" hint={`Now: ${current.driver}`}>
          <Select id="cr-driver" value={driver} onChange={(e) => setDriver(e.target.value)} className="s-select py-1.5">
            <option value="">Keep as it is</option>
            {kindDrivers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </Select>
        </Field>
        <Field label="Address (base URL)" htmlFor="cr-url" hint={current.baseUrl ? `Now: ${current.baseUrl}` : 'None set now'}>
          <input id="cr-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" maxLength={500} className="s-input py-1.5" />
        </Field>
        <Field label={kind === 'fiscal' ? 'Timeout (ms)' : 'Charge timeout (seconds)'} htmlFor="cr-timeout">
          <input id="cr-timeout" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutV(e.target.value.replace(/[^\d]/g, ''))} className="s-input py-1.5" />
        </Field>
        <Field label="New API key" htmlFor="cr-key" hint={current.apiKeyHint ? `Now: ${current.apiKeyHint}. Typed once; sealed on send and never shown again.` : 'Typed once; sealed on send and never shown again.'}>
          <input id="cr-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); if (e.target.value) setClearKey(false) }} className="s-input py-1.5" />
          <label className="mt-1 flex items-center gap-2 text-xs text-s-muted">
            <input type="checkbox" style={{ accentColor: 'var(--erp-accent)' }} checked={clearKey} disabled={!!apiKey} onChange={(e) => setClearKey(e.target.checked)} />
            Clear the stored key instead
          </label>
        </Field>
        <Field label="New webhook secret" htmlFor="cr-secret" hint={current.webhookSecretHint ? `Now: ${current.webhookSecretHint}. Typed once; sealed on send.` : 'Typed once; sealed on send.'}>
          <input id="cr-secret" type="password" autoComplete="new-password" value={webhookSecret} onChange={(e) => { setWebhookSecret(e.target.value); if (e.target.value) setClearSecret(false) }} className="s-input py-1.5" />
          <label className="mt-1 flex items-center gap-2 text-xs text-s-muted">
            <input type="checkbox" style={{ accentColor: 'var(--erp-accent)' }} checked={clearSecret} disabled={!!webhookSecret} onChange={(e) => setClearSecret(e.target.checked)} />
            Clear the stored secret instead
          </label>
        </Field>
        {kind === 'terminal' && (
          <Field label="Card machine at the till" htmlFor="cr-enabled" hint={`Now: ${data.terminal.enabled ? 'on' : 'off'}`}>
            <Select id="cr-enabled" value={enabled} onChange={(e) => setEnabled(e.target.value as '' | 'on' | 'off')} className="s-select py-1.5">
              <option value="">Keep as it is</option>
              <option value="on">Switch on</option>
              <option value="off">Switch off</option>
            </Select>
          </Field>
        )}
      </div>
      <ErrorLine>{err}</ErrorLine>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="s-btn-primary text-sm" disabled={nothing || send.isPending || !activeTenantId}>
          {send.isPending ? 'Sending…' : 'Send for approval'}
        </button>
        <button type="button" className="s-btn-ghost text-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
