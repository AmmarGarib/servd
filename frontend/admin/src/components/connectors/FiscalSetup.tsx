'use client'
// POS connector → Fiscal setup tab (spec §10, §8.1, §17.0, §17.7).
//
//   • "Fiscal reporting" — the company switch (§17.7). CEO only, reason
//     required, audited server-side. Off = this company's sales create no
//     fiscal document at all (non-commercial / test company).
//   • Driver, address, API key (hint only, never shown), webhook secret (hint;
//     a regenerated one is shown ONCE), webhook URL (copy / rotate), settings.
//     While the fiscal POS is live, the driver and address are locked: the
//     server answers 409 SWITCH_OFF_FIRST — the CEO switches off, IT edits and
//     tests, the CEO goes live again.
//   • Test connection / dry-run sale.
//   • Go live and switch off (CEO, typed confirmation, readiness checklist).
//   • Release ALL held documents (CEO; optionally one brand). No date range
//     and no skip — every held sale is filed, late (§17.0).

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  connectorsApi, connectorErrorText, missingFrom, useDrivers,
  type ConnectorsOverview, type FiscalSettings, type ReportingRequiredResult, type TestResult,
} from '../../lib/connectorsApi'
import { Badge, Banner, Card, ConfirmPhrase, ErrorLine, Field, Modal, OkLine, RangeNumberInput, TestBadge, fmtWhen } from './ui'
import { Select } from '@/components/ui/Select'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { useConfirm } from '@/components/ui/ConfirmDialog'

const FISCAL_TEST_SCENARIOS = ['ok', 'slow', 'down', 'reject', 'auth', 'processing_then_ok', 'unknown_then_filed'] as const

export function FiscalSetup({ data, companyName, canEdit, isCeo }: {
  data: ConnectorsOverview
  companyName: string
  /** CEO + IT (CONNECTOR_ADMINS). */
  canEdit: boolean
  /** role admin — go-live, switch-off, release, the reporting switch. */
  isCeo: boolean
}) {
  // §17.7 off only stops NEW documents. Documents created while reporting was
  // required stay exactly as they are: pending / failed ones keep filing while
  // the connector is live, held ones wait for a release. So the switch-off and
  // release controls stay reachable for them.
  const leftover = openDocCounts(data)
  const stranded = !data.fiscalReportingRequired && (data.fiscal.enabled || leftover.total > 0)
  return (
    <div className="space-y-4">
      <ReportingSwitch data={data} companyName={companyName} isCeo={isCeo} />
      {data.fiscalReportingRequired && (
        <>
          <ConnectionCard data={data} canEdit={canEdit} />
          <TestCard data={data} canEdit={canEdit} />
          <GoLiveCard data={data} isCeo={isCeo} />
          <ReleaseHeldCard data={data} isCeo={isCeo} />
        </>
      )}
      {stranded && (
        <>
          <Banner tone="warn" title="Documents from before reporting was switched off">
            <p>
              No new sale creates a fiscal document, but the {leftover.total} created earlier are left as they are
              ({leftover.text}).{' '}
              {data.fiscal.enabled
                ? 'The fiscal POS is still live, so pending and failed ones keep filing and can be retried. Held ones are not released while reporting is off. Switch off to stop all of it — they then stay as they are.'
                : 'The fiscal POS is off, so nothing more is sent.'}
            </p>
            {data.heldNote && <p className="mt-1">{data.heldNote}</p>}
          </Banner>
          <GoLiveCard data={data} isCeo={isCeo} />
          {data.counts.held > 0 && <ReleaseHeldCard data={data} isCeo={isCeo} />}
        </>
      )}
    </div>
  )
}

/** Documents still open (not filed / skipped / resolved). */
function openDocCounts(data: ConnectorsOverview): { total: number; text: string } {
  const c = data.counts
  const parts: Array<[string, number]> = [
    ['held', c.held], ['waiting', c.waiting], ['pending', c.pending],
    ['failed', c.failed + c.rejected], ['to file by hand', c.manualRequired],
  ]
  const nonzero = parts.filter(([, n]) => n > 0)
  return {
    total: nonzero.reduce((a, [, n]) => a + n, 0),
    text: nonzero.length ? nonzero.map(([k, n]) => `${n} ${k}`).join(', ') : 'none',
  }
}

// ─── §17.7 Fiscal reporting required ─────────────────────────────────────────

function ReportingSwitch({ data, companyName, isCeo }: { data: ConnectorsOverview; companyName: string; isCeo: boolean }) {
  const qc = useQueryClient()
  const current = data.fiscalReportingRequired
  const [open, setOpen] = useState(false)
  const [next, setNext] = useState(current)
  const [reason, setReason] = useState('')
  const [saved, setSaved] = useState<ReportingRequiredResult | null>(null)
  useEffect(() => { if (!open) { setNext(current); setReason('') } }, [open, current])
  const m = useMutation({
    mutationFn: () => connectorsApi.setReportingRequired(next, reason.trim()),
    onSuccess: (r) => { setSaved(r); void qc.invalidateQueries({ queryKey: ['connectors'] }); setOpen(false) },
  })
  return (
    <Card
      title="Fiscal reporting"
      subtitle="Whether this company's sales are filed with FBR / SRB at all. Applies to the whole company — never per sale, brand or date."
      actions={isCeo ? <button className="s-btn-secondary text-xs" onClick={() => setOpen(true)}>Change</button> : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={current ? 'ok' : 'warn'}>{current ? 'Required' : 'Not required (non-commercial or test company)'}</Badge>
        {!isCeo && <span className="text-xs text-s-muted">Only the CEO can change this.</span>}
      </div>
      {saved && saved.fiscalReportingRequired === current && (
        <OkLine>
          Saved. {saved.fiscalReportingRequired
            ? (saved.heldCount > 0 ? `${saved.heldCount} held sale${saved.heldCount === 1 ? ' is' : 's are'} still held — release them below once the fiscal POS is live.` : 'Sales completed from now on are filed.')
            : (saved.heldCount > 0 ? `${saved.heldCount} held sale${saved.heldCount === 1 ? ' is' : 's are'} kept as they are (never skipped).` : 'No held sales.')}
        </OkLine>
      )}
      {!current && data.heldNote && <p className="text-xs text-s-text">{data.heldNote}</p>}
      {open && (
        <Modal title={`Fiscal reporting for ${companyName}`} onClose={() => setOpen(false)}>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" checked={next} onChange={() => setNext(true)} className="mt-1" />
              <span><strong>Required</strong> — every full &amp; final bill is filed with the fiscal POS.</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" checked={!next} onChange={() => setNext(false)} className="mt-1" />
              <span><strong>Not required</strong> (non-commercial or test company) — no fiscal document is created for this company&rsquo;s sales; receipts print &ldquo;Not a tax invoice&rdquo;. The card machine keeps working.</span>
            </label>
          </div>
          {next && !current && (
            <p className="text-xs text-s-muted">
              Applies to sales completed from now on. Sales completed while it was off have no fiscal document and are not filed.
              {data.counts.held > 0 && ` The ${data.counts.held} sale${data.counts.held === 1 ? '' : 's'} held from before it was switched off can be released again (Release held sales, once the fiscal POS is live) or recorded as filed by hand.`}
            </p>
          )}
          {!next && current && (() => {
            const open = openDocCounts(data)
            return (
              <div className="rounded-lg border border-s-amber/40 bg-s-amber-dim p-3 text-xs text-s-text space-y-1">
                <p className="font-semibold text-s-amber">Applies to sales completed from now on.</p>
                <p>
                  {open.total === 0
                    ? 'This company has no open fiscal documents.'
                    : `The ${open.total} open document${open.total === 1 ? '' : 's'} already created (${open.text}) stay as they are — they are not deleted or skipped.`}
                  {data.fiscal.enabled
                    ? ' The fiscal POS stays live: pending and failed ones keep filing. Switch off on this tab afterwards if you want nothing more sent.'
                    : ' The fiscal POS is off, so nothing more is sent; held ones stay held until released or filed by hand.'}
                </p>
              </div>
            )
          })()}
          <Field label="Reason (required, kept in the audit log)">
            <textarea className="s-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
              placeholder={next ? 'e.g. Company starts trading on 1 November' : "e.g. Owner's home kitchen — not a commercial sale"} />
          </Field>
          <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
          <div className="flex justify-end gap-2">
            <button className="s-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="s-btn-primary" disabled={m.isPending || next === current || reason.trim().length < 3} onClick={() => m.mutate()}>
              {m.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  )
}

// ─── Driver, address, secrets, settings ─────────────────────────────────────

function ConnectionCard({ data, canEdit }: { data: ConnectorsOverview; canEdit: boolean }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const f = data.fiscal
  const drivers = useDrivers()
  const fiscalDrivers = (drivers.data ?? []).filter((d) => d.kind === 'fiscal')
  const live = f.enabled
  const locked = live || !canEdit

  const [driver, setDriver] = useState(f.driver)
  const [baseUrl, setBaseUrl] = useState(f.baseUrl ?? '')
  const [apiKey, setApiKey] = useState<string | null>(null)   // null = unchanged
  const [s, setS] = useState<FiscalSettings>(f.settings)
  // SRB direct (2026-10-30): POS user + Live switch live in settings.srb; the password is the API key.
  const [srbUser, setSrbUser] = useState(f.settings.srb?.posUser ?? '')
  const [srbLive, setSrbLive] = useState(f.settings.srb?.live ?? false)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [badNums, setBadNums] = useState<Record<string, boolean>>({})
  const numbersBad = Object.values(badNums).some(Boolean)
  // Reset the form only when the SERVER copy really changes (a save, or
  // another person's edit) — not on every 10 s poll, which returns new objects.
  const serverKey = JSON.stringify([f.driver, f.baseUrl, f.settings])
  useEffect(() => {
    setDriver(f.driver); setBaseUrl(f.baseUrl ?? ''); setS(f.settings)
    setSrbUser(f.settings.srb?.posUser ?? ''); setSrbLive(f.settings.srb?.live ?? false)
  }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const needs = fiscalDrivers.find((d) => d.id === driver)?.needs ?? { baseUrl: driver === 'http', apiKey: driver === 'http' || driver === 'srb', webhookSecret: false }
  const isSrb = driver === 'srb'
  const srbChanged = isSrb && (srbUser.trim() !== (f.settings.srb?.posUser ?? '') || srbLive !== (f.settings.srb?.live ?? false))
  // The server needs a POS user before the SRB block can be saved.
  const srbIncomplete = srbChanged && !srbUser.trim()

  const changed = useMemo(() => {
    const body: Record<string, unknown> = {}
    if (driver !== f.driver) body['driver'] = driver
    if (baseUrl.trim() !== (f.baseUrl ?? '')) body['baseUrl'] = baseUrl.trim()
    if (apiKey !== null) body['apiKey'] = apiKey
    const settings: Record<string, unknown> = {}
    for (const k of ['syncTimeoutMs', 'syncAtTill', 'fileZeroValue', 'maxAgeHours'] as const) {
      if (s[k] !== f.settings[k]) settings[k] = s[k]
    }
    if ((s.test?.scenario ?? 'ok') !== (f.settings.test?.scenario ?? 'ok')) settings['test'] = { scenario: s.test?.scenario ?? 'ok' }
    if (srbChanged && srbUser.trim()) settings['srb'] = { posUser: srbUser.trim(), live: srbLive }
    if (Object.keys(settings).length) body['settings'] = settings
    return body
  }, [driver, baseUrl, apiKey, s, f, srbChanged, srbUser, srbLive])

  const save = useMutation({
    mutationFn: () => connectorsApi.save<FiscalSettings>('fiscal', changed),
    onSuccess: () => { setApiKey(null); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const regen = useMutation({
    mutationFn: () => connectorsApi.save<FiscalSettings>('fiscal', { regenerateWebhookSecret: true }),
    onSuccess: (r) => { setNewSecret(r.newWebhookSecret ?? null); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const rotate = useMutation({
    mutationFn: () => connectorsApi.rotateWebhookToken('fiscal'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connectors'] }),
  })

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500) } catch { /* clipboard blocked */ }
  }

  return (
    <Card title="Connection" subtitle="Which fiscal POS servd talks to, and how." actions={f.isTest ? <TestBadge /> : undefined}>
      {live && (
        <Banner tone="info" title="The fiscal POS is live — the driver and address are locked">
          <p>To change them: the CEO switches off (new sales are held, nothing is lost), IT edits and tests, the CEO goes live again. The API key and settings can still change.</p>
        </Banner>
      )}
      {!canEdit && <p className="text-xs text-s-muted">Read-only — the CEO and IT configure the connector.</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Driver" htmlFor="fx-driver" hint={driver === 'test' ? 'Built in. Files TEST numbers — never a real fiscal invoice.' : driver === 'none' ? 'Off. Sales are held until a driver is set and the CEO goes live.' : isSrb ? 'servd files every bill with SRB itself — bills closed in servd included. No fiscal POS, no “Push to Keenu”.' : undefined}>
          <Select id="fx-driver" className="s-select" value={driver} disabled={locked} onChange={(e) => setDriver(e.target.value)}>
            {fiscalDrivers.length === 0 && <option value={f.driver}>{f.driver}</option>}
            {fiscalDrivers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </Select>
        </Field>
        {!isSrb && (needs.baseUrl || f.baseUrl) && (
          <Field label="Base URL" htmlFor="fx-url" hint="The vendor's https:// address. Private and local addresses are refused.">
            <input id="fx-url" className="s-input font-mono text-xs" value={baseUrl} disabled={locked} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://fiscal.vendor.pk/servd/v1" />
          </Field>
        )}
      </div>

      {isSrb && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="SRB POS user" htmlFor="fx-srb-user" hint="The pos_user SRB issued when the POS was registered.">
            <input id="fx-srb-user" className="s-input font-mono text-xs" value={srbUser} disabled={locked} maxLength={64}
              autoComplete="off" autoCapitalize="none" spellCheck={false}
              onChange={(e) => setSrbUser(e.target.value)} placeholder="e.g. 4bs8gf55" />
          </Field>
          <Field label="SRB mode" htmlFor="fx-srb-live" hint={srbLive ? 'Live — every bill becomes a real SRB invoice once the CEO goes live.' : 'Test — SRB answers with test invoices; nothing is a real tax invoice. Test first, then switch to Live.'}>
            <label className="flex min-h-10 items-center gap-2 text-sm text-s-text">
              <input id="fx-srb-live" type="checkbox" className="h-4 w-4"
                checked={srbLive} disabled={locked} onChange={(e) => setSrbLive(e.target.checked)} />
              <span>Live (not test)</span>
              <Badge tone={srbLive ? 'ok' : 'warn'}>{srbLive ? 'Live' : 'Test'}</Badge>
            </label>
          </Field>
        </div>
      )}
      {isSrb && srbIncomplete && <p className="text-xs text-s-amber">Enter the SRB POS user to save the SRB settings.</p>}
      {isSrb && live && <p className="text-xs text-s-muted">The SRB POS user and mode are locked while live — the CEO switches off first.</p>}

      {(needs.apiKey || f.apiKeyHint) && (
        <Field label={isSrb ? 'SRB POS password' : 'API key'} hint="Stored encrypted. Never shown again once saved — only its first and last four characters.">
          {apiKey === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-s-text">{f.apiKeyHint ?? 'Not set'}</span>
              {canEdit && <button className="s-btn-secondary px-2 py-1 text-xs" onClick={() => setApiKey('')}>{f.apiKeyHint ? 'Replace' : isSrb ? 'Set password' : 'Set key'}</button>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <PasswordInput name="fiscal-api-key" autoComplete="new-password" autoCapitalize="none" spellCheck={false} wrapperClassName="flex-1 min-w-[200px]" className="s-input font-mono text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={isSrb ? 'The pos_pass SRB issued' : 'Paste the key from the vendor'} />
              <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setApiKey(null)}>Keep current</button>
              {f.apiKeyHint && <span className="text-[11px] text-s-muted">Saving it empty removes the key.</span>}
            </div>
          )}
        </Field>
      )}

      {!isSrb && <Field label="Webhook" hint="The fiscal POS calls this address when a document is filed later. Signed with the webhook secret.">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-[11px] break-all rounded bg-s-bg px-2 py-1 text-s-text">{f.webhookUrl}</code>
          <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => void copy(f.webhookUrl, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
          {canEdit && <button className="s-btn-ghost px-2 py-1 text-xs" disabled={rotate.isPending} onClick={async () => { if (await confirm({ title: 'Issue a new webhook address?', body: 'The old one stops working at once — give the vendor the new one.', confirmLabel: 'Issue new address', danger: true })) rotate.mutate() }}>New address</button>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-s-muted">Secret:</span>
          <span className="font-mono text-s-text">{f.webhookSecretHint ?? 'Not set'}</span>
          {canEdit && <button className="s-btn-secondary px-2 py-1 text-xs" disabled={regen.isPending} onClick={async () => { if (!f.webhookSecretHint || await confirm({ title: 'Generate a new webhook secret?', body: 'The vendor must switch to it — the old one stops verifying.', confirmLabel: 'Generate', danger: true })) regen.mutate() }}>{regen.isPending ? 'Generating…' : 'Regenerate'}</button>}
        </div>
        {newSecret && (
          <div className="mt-2 rounded-lg border border-s-amber/40 bg-s-amber-dim p-3 text-xs space-y-1">
            <p className="font-semibold text-s-amber">Copy it now — it is shown only this once.</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all font-mono text-s-text">{newSecret}</code>
              <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => void copy(newSecret, 'secret')}>{copied === 'secret' ? 'Copied' : 'Copy'}</button>
              <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setNewSecret(null)}>Done</button>
            </div>
          </div>
        )}
        <ErrorLine>{regen.error ? connectorErrorText(regen.error) : rotate.error ? connectorErrorText(rotate.error) : null}</ErrorLine>
      </Field>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Wait at the till (ms)" htmlFor="fx-sync" hint="How long the till waits for the fiscal number before printing “pending” (500–5000). A sale is never blocked.">
          <RangeNumberInput id="fx-sync" min={500} max={5000} step={100} className="max-w-[160px]" disabled={!canEdit}
            value={s.syncTimeoutMs} onChange={(n) => setS((p) => ({ ...p, syncTimeoutMs: n }))}
            onValidChange={(ok) => setBadNums((b) => ({ ...b, syncTimeoutMs: !ok }))} />
        </Field>
        <Field label="Give up after (hours)" htmlFor="fx-age" hint="An unfiled document is marked failed (and alerted) after this long (1–168).">
          <RangeNumberInput id="fx-age" min={1} max={168} className="max-w-[160px]" disabled={!canEdit}
            value={s.maxAgeHours} onChange={(n) => setS((p) => ({ ...p, maxAgeHours: n }))}
            onValidChange={(ok) => setBadNums((b) => ({ ...b, maxAgeHours: !ok }))} />
        </Field>
      </div>
      <div className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input type="checkbox" disabled={!canEdit} checked={s.syncAtTill} onChange={(e) => setS({ ...s, syncAtTill: e.target.checked })} className="mt-1" />
          <span>File at the till — try for the fiscal number before the receipt prints</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" disabled={!canEdit} checked={s.fileZeroValue} onChange={(e) => setS({ ...s, fileZeroValue: e.target.checked })} className="mt-1" />
          <span>File zero-value bills too (comps, staff meals)</span>
        </label>
      </div>
      {driver === 'test' && (
        <Field label="Test driver behaviour" hint="For rehearsing failures before a real vendor is connected.">
          <Select className="s-select max-w-[260px]" disabled={!canEdit} value={s.test?.scenario ?? 'ok'} onChange={(e) => setS({ ...s, test: { scenario: e.target.value } })}>
            {FISCAL_TEST_SCENARIOS.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="s-btn-primary" disabled={save.isPending || numbersBad || srbIncomplete || Object.keys(changed).length === 0} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && Object.keys(changed).length === 0 && <OkLine>Saved.</OkLine>}
          <ErrorLine>{save.error ? connectorErrorText(save.error) : null}</ErrorLine>
        </div>
      )}
    </Card>
  )
}

// ─── Test ────────────────────────────────────────────────────────────────────

function TestCard({ data, canEdit }: { data: ConnectorsOverview; canEdit: boolean }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<TestResult | null>(null)
  const m = useMutation({
    mutationFn: (dryRun: boolean) => connectorsApi.test('fiscal', { dryRun }),
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const f = data.fiscal
  return (
    <Card title="Test" subtitle="Test connection asks the fiscal POS if it is up. Dry-run sale also files a PKR 100 test sale that servd never stores.">
      <div className="flex flex-wrap items-center gap-2">
        <button className="s-btn-secondary" disabled={!canEdit || m.isPending || f.driver === 'none'} onClick={() => { setResult(null); m.mutate(false) }}>
          {m.isPending && m.variables === false ? 'Testing…' : 'Test connection'}
        </button>
        <button className="s-btn-secondary" disabled={!canEdit || m.isPending || f.driver === 'none'} onClick={() => { setResult(null); m.mutate(true) }}>
          {m.isPending && m.variables === true ? 'Filing…' : 'Dry-run sale'}
        </button>
        {f.driver === 'none' && <span className="text-xs text-s-muted">Pick a driver first.</span>}
      </div>
      {result && (
        <div className={`rounded-lg border p-3 text-xs ${result.ok ? 'border-s-green/40 bg-s-green-dim' : 'border-s-red/40 bg-s-red-dim'}`}>
          <p className={`font-semibold ${result.ok ? 'text-s-green' : 'text-s-red'}`}>{result.ok ? 'Passed' : 'Failed'} — {result.latencyMs} ms</p>
          <p className="text-s-text break-words">{result.detail}</p>
          {result.dryRun && <p className="text-s-text">Dry-run sale: {result.dryRun.outcome}{result.dryRun.fiscalNumber ? ` — ${result.dryRun.fiscalNumber}` : ''}</p>}
        </div>
      )}
      <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
      {f.lastTestAt && !result && <p className="text-xs text-s-muted">Last test {fmtWhen(f.lastTestAt)}: {f.lastTestOk ? 'passed' : 'failed'}.</p>}
    </Card>
  )
}

// ─── Go live / switch off ────────────────────────────────────────────────────

function readiness(data: ConnectorsOverview): Array<{ label: string; ok: boolean }> {
  const f = data.fiscal
  const tested = !!(f.lastTestOk && f.lastTestAt && Date.now() - new Date(f.lastTestAt).getTime() < 10 * 60_000)
  const outlets = f.settings.outlets ?? []
  const unregistered = data.brandPosIds.filter((b) => !b.fbrPosId && !b.srbPosId && !outlets.some((o) => o.conceptId === b.conceptId || o.conceptId === null))
  return [
    { label: 'A fiscal POS driver is picked', ok: f.driver !== 'none' },
    ...(f.driver === 'srb' ? [{ label: 'SRB is set to Live (after a passing Test)', ok: f.settings.srb?.live === true }] : []),
    { label: 'Test connection passed in the last 10 minutes', ok: tested },
    { label: unregistered.length ? `POS ids for: ${unregistered.map((b) => b.name).join(', ')} (brands that traded in the last 30 days must have one)` : 'Every brand has a POS id', ok: unregistered.length === 0 },
    { label: 'The old direct FBR / SRB queues are drained', ok: data.legacyDrained },
  ]
}

function GoLiveCard({ data, isCeo }: { data: ConnectorsOverview; isCeo: boolean }) {
  const qc = useQueryClient()
  const f = data.fiscal
  const [dialog, setDialog] = useState<'live' | 'off' | null>(null)
  const [phrase, setPhrase] = useState('')
  const checks = readiness(data)
  const m = useMutation({
    mutationFn: () => (dialog === 'live' ? connectorsApi.goLive() : connectorsApi.switchOff()),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connectors'] }); setDialog(null); setPhrase('') },
  })
  const missing = m.error ? missingFrom(m.error) : []
  const want = dialog === 'live' ? 'GO LIVE' : 'SWITCH OFF'

  return (
    <Card title="Go live" subtitle={data.fiscalReportingRequired
      ? 'Until the CEO goes live, every sale is held — visible here, never sent. Going live files new sales; release the held ones below.'
      : 'Reporting is not required, so new sales create no document. This only controls whether the documents created earlier are still sent.'}>
      <div className="flex flex-wrap items-center gap-2">
        {f.enabled
          ? <Badge tone="ok">{f.liveSince ? `Live since ${fmtWhen(f.liveSince)}` : 'Live'}</Badge>
          : <Badge tone="warn">Off</Badge>}
        {f.isTest && <TestBadge />}
      </div>
      {!f.enabled && (
        <ul className="space-y-1 text-xs">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2">
              <span aria-hidden className={`mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${c.ok ? 'bg-s-green' : 'bg-s-amber'}`} />
              <span className={c.ok ? 'text-s-muted' : 'text-s-text'}>{c.label}</span>
            </li>
          ))}
        </ul>
      )}
      {isCeo ? (
        <div className="flex flex-wrap gap-2">
          {!f.enabled && <button className="s-btn-primary" onClick={() => { m.reset(); setDialog('live') }}>Go live…</button>}
          {f.enabled && <button className="s-btn-danger" onClick={() => { m.reset(); setDialog('off') }}>Switch off…</button>}
        </div>
      ) : <p className="text-xs text-s-muted">Only the CEO goes live or switches off.</p>}

      {dialog && (
        <Modal title={dialog === 'live' ? 'Go live with the fiscal POS' : 'Switch the fiscal POS off'} onClose={() => setDialog(null)}>
          {dialog === 'live' ? (
            <p className="text-xs text-s-text">
              From now on every full &amp; final bill of this company is filed through <span className="font-mono">{f.driver}</span>
              {f.isTest && ' — the TEST driver: numbers are not real fiscal invoices'}. Sales held so far stay held until you release them.
            </p>
          ) : (
            <p className="text-xs text-s-text">New sales are held (nothing is lost) until you go live again. Documents already sending finish; pending ones go back to held.</p>
          )}
          <ConfirmPhrase phrase={want} value={phrase} onChange={setPhrase} />
          <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
          {missing.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-s-red">{missing.map((x) => <li key={x}>{x}</li>)}</ul>
          )}
          <div className="flex justify-end gap-2">
            <button className="s-btn-ghost" onClick={() => setDialog(null)}>Cancel</button>
            <button className={dialog === 'live' ? 's-btn-primary' : 's-btn-danger'} disabled={phrase !== want || m.isPending} onClick={() => m.mutate()}>
              {m.isPending ? 'Working…' : dialog === 'live' ? 'Go live' : 'Switch off'}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  )
}

// ─── Release ALL held (no date range, no skip) ──────────────────────────────

function ReleaseHeldCard({ data, isCeo }: { data: ConnectorsOverview; isCeo: boolean }) {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState('')
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<{ released: number; stillHeld: number } | null>(null)
  const m = useMutation({
    mutationFn: () => connectorsApi.releaseHeld(conceptId || undefined),
    onSuccess: (r) => { setResult(r); setOpen(false); void qc.invalidateQueries({ queryKey: ['connectors'] }); void qc.invalidateQueries({ queryKey: ['fiscal-docs'] }) },
  })
  const held = data.counts.held
  const brand = data.brandPosIds.find((b) => b.conceptId === conceptId)
  return (
    <Card title="Release held sales"
      subtitle="Every held sale is filed (late) once released — there is no date range and no way to skip a real sale. Sales of a brand still without a POS id stay held.">
      <p className="text-sm text-s-text"><strong>{held}</strong> held document{held === 1 ? '' : 's'}.</p>
      {isCeo ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Brand">
            <Select className="s-select min-w-[200px]" value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
              <option value="">All brands</option>
              {data.brandPosIds.map((b) => <option key={b.conceptId} value={b.conceptId}>{b.name}</option>)}
            </Select>
          </Field>
          <button className="s-btn-primary" disabled={held === 0 || !data.fiscal.enabled || !data.fiscalReportingRequired || m.isPending} onClick={() => setOpen(true)}>Release all held…</button>
          {!data.fiscalReportingRequired
            ? <span className="text-xs text-s-muted">Fiscal reporting is off — switch it back on first. The held sales are kept.</span>
            : !data.fiscal.enabled && <span className="text-xs text-s-muted">Go live first.</span>}
        </div>
      ) : <p className="text-xs text-s-muted">Only the CEO releases held sales.</p>}
      {result && <OkLine>Released {result.released}. Still held (no POS id yet): {result.stillHeld}.</OkLine>}
      <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
      {open && (
        <Modal title="Release held sales" onClose={() => setOpen(false)}>
          <p className="text-sm text-s-text">
            File every held sale of {brand ? <strong>{brand.name}</strong> : <strong>every brand</strong>} now, late. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button className="s-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="s-btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Releasing…' : 'Release all held'}</button>
          </div>
        </Modal>
      )}
    </Card>
  )
}
