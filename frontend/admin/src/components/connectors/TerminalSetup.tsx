'use client'
// POS connector → Card machine tab (spec §10, §7). The terminal connector is
// independent of the fiscal one (and of the §17.7 reporting switch): driver,
// on/off (the "Charge on card machine" button at the till), address, key,
// webhook secret, timings, the manual-reference fallback and the card
// machines per outlet.

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  connectorsApi, connectorErrorText, useDrivers,
  type ConnectorsOverview, type TerminalEntry, type TerminalSettings, type TestResult,
} from '../../lib/connectorsApi'
import { useCompanyLocations } from './PosIdsTable'
import { Badge, Card, ErrorLine, Field, OkLine, RangeNumberInput, TestBadge, fmtWhen } from './ui'
import { Select } from '@/components/ui/Select'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { useConfirm } from '@/components/ui/ConfirmDialog'

const TERMINAL_TEST_SCENARIOS = ['approve', 'decline', 'never', 'unknown_start', 'late_approve', 'void_fails', 'offline', 'by_amount'] as const

type Row = Omit<TerminalEntry, 'id'> & { id?: string }

export function TerminalSetup({ data, canEdit, activeTenantId }: { data: ConnectorsOverview; canEdit: boolean; activeTenantId: string | null }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const t = data.terminal
  const drivers = useDrivers()
  const termDrivers = (drivers.data ?? []).filter((d) => d.kind === 'terminal')
  const locations = useCompanyLocations(activeTenantId)

  const [driver, setDriver] = useState(t.driver)
  const [enabled, setEnabled] = useState(t.enabled)
  const [baseUrl, setBaseUrl] = useState(t.baseUrl ?? '')
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [s, setS] = useState<TerminalSettings>(t.settings)
  const [rows, setRows] = useState<Row[]>(t.settings.terminals)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testTerminal, setTestTerminal] = useState('')
  const [badNums, setBadNums] = useState<Record<string, boolean>>({})
  const numbersBad = Object.values(badNums).some(Boolean)
  const serverKey = JSON.stringify([t.driver, t.enabled, t.baseUrl, t.settings])
  useEffect(() => {
    setDriver(t.driver); setEnabled(t.enabled); setBaseUrl(t.baseUrl ?? ''); setS(t.settings); setRows(t.settings.terminals)
  }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const needs = termDrivers.find((d) => d.id === driver)?.needs ?? { baseUrl: driver === 'http', apiKey: driver === 'http', webhookSecret: driver === 'http' }

  const body = useMemo(() => {
    const b: Record<string, unknown> = {}
    if (driver !== t.driver) b['driver'] = driver
    if (enabled !== t.enabled) b['enabled'] = enabled
    if (baseUrl.trim() !== (t.baseUrl ?? '')) b['baseUrl'] = baseUrl.trim()
    if (apiKey !== null) b['apiKey'] = apiKey
    const settings: Record<string, unknown> = {}
    for (const k of ['chargeTimeoutSec', 'pollMs', 'allowManualRef'] as const) if (s[k] !== t.settings[k]) settings[k] = s[k]
    if ((s.test?.scenario ?? 'approve') !== (t.settings.test?.scenario ?? 'approve')) settings['test'] = { scenario: s.test?.scenario ?? 'approve' }
    const cleaned = rows.map((r) => ({ ...(r.id && { id: r.id }), label: r.label.trim(), locationId: r.locationId, terminalId: r.terminalId.trim(), active: r.active }))
    if (JSON.stringify(cleaned) !== JSON.stringify(t.settings.terminals.map((r) => ({ id: r.id, label: r.label, locationId: r.locationId, terminalId: r.terminalId, active: r.active })))) {
      settings['terminals'] = cleaned
    }
    if (Object.keys(settings).length) b['settings'] = settings
    return b
  }, [driver, enabled, baseUrl, apiKey, s, rows, t])
  const invalid = rows.some((r) => !r.label.trim() || !r.locationId || !r.terminalId.trim())

  const save = useMutation({
    mutationFn: () => connectorsApi.save<TerminalSettings>('terminal', body),
    onSuccess: () => { setApiKey(null); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const regen = useMutation({
    mutationFn: () => connectorsApi.save<TerminalSettings>('terminal', { regenerateWebhookSecret: true }),
    onSuccess: (r) => { setNewSecret(r.newWebhookSecret ?? null); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const rotate = useMutation({
    mutationFn: () => connectorsApi.rotateWebhookToken('terminal'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connectors'] }),
  })
  const test = useMutation({
    mutationFn: () => connectorsApi.test('terminal', testTerminal ? { terminalId: testTerminal } : {}),
    onSuccess: (r) => { setTestResult(r); void qc.invalidateQueries({ queryKey: ['connectors'] }) },
  })
  const setRow = (i: number, p: Partial<Row>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const locName = (id: string) => locations.data.find((l) => l.id === id)?.name ?? '—'

  return (
    <div className="space-y-4">
      <Card title="Card machine" subtitle="Pushes the bill to the card machine at the till and records the payment when the bank approves. Independent of fiscal filing."
        actions={<>{t.isTest && <TestBadge />}<Badge tone={t.enabled ? 'ok' : 'muted'}>{t.enabled ? 'On at the till' : 'Off'}</Badge></>}>
        {!canEdit && <p className="text-xs text-s-muted">Read-only — the CEO and IT configure the card machine.</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Driver" htmlFor="tm-driver" hint={driver === 'test' ? 'Built in — no money moves. For rehearsing the till flow.' : undefined}>
            <Select id="tm-driver" className="s-select" disabled={!canEdit} value={driver} onChange={(e) => { setDriver(e.target.value); if (e.target.value === 'none') { setEnabled(false); setS({ ...s, allowManualRef: true }) } }}>
              {termDrivers.length === 0 && <option value={t.driver}>{t.driver}</option>}
              {termDrivers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </Select>
          </Field>
          <Field label="Shown at the till" hint="When on, cashiers see “Charge on card machine”.">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={!canEdit || driver === 'none'} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>{enabled ? 'Enabled' : 'Disabled'}</span>
            </label>
            {enabled && driver === 'test' && (
              <p role="alert" className="mt-1 text-[11px] font-semibold text-s-red">TEST driver: card sales will be recorded as paid with no card charged.</p>
            )}
          </Field>
          {(needs.baseUrl || t.baseUrl) && (
            <Field label="Base URL" htmlFor="tm-url" hint="The processor's https:// address.">
              <input id="tm-url" className="s-input font-mono text-xs" disabled={!canEdit} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://terminals.processor.pk/servd/v1" />
            </Field>
          )}
        </div>

        {(needs.apiKey || t.apiKeyHint) && (
          <Field label="API key" hint="Stored encrypted; only its first and last four characters are ever shown.">
            {apiKey === null ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-s-text">{t.apiKeyHint ?? 'Not set'}</span>
                {canEdit && <button className="s-btn-secondary px-2 py-1 text-xs" onClick={() => setApiKey('')}>{t.apiKeyHint ? 'Replace' : 'Set key'}</button>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <PasswordInput name="terminal-api-key" autoComplete="new-password" autoCapitalize="none" spellCheck={false} wrapperClassName="flex-1 min-w-[200px]" className="s-input font-mono text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste the key from the processor" />
                <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setApiKey(null)}>Keep current</button>
              </div>
            )}
          </Field>
        )}

        {(needs.webhookSecret || t.webhookSecretHint) && (
          <Field label="Webhook" hint="The processor reports approvals here, signed with the secret.">
            <code className="block text-[11px] break-all rounded bg-s-bg px-2 py-1 text-s-text">{t.webhookUrl}</code>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-s-muted">Secret:</span>
              <span className="font-mono text-s-text">{t.webhookSecretHint ?? 'Not set'}</span>
              {canEdit && <button className="s-btn-secondary px-2 py-1 text-xs" disabled={regen.isPending} onClick={async () => { if (!t.webhookSecretHint || await confirm({ title: 'Generate a new webhook secret?', body: 'The processor must switch to it.', confirmLabel: 'Generate', danger: true })) regen.mutate() }}>Regenerate</button>}
              {canEdit && <button className="s-btn-ghost px-2 py-1 text-xs" disabled={rotate.isPending} onClick={async () => { if (await confirm({ title: 'Issue a new webhook address?', body: 'The old one stops working at once.', confirmLabel: 'Issue new address', danger: true })) rotate.mutate() }}>New address</button>}
            </div>
            {newSecret && (
              <div className="mt-2 rounded-lg border border-s-amber/40 bg-s-amber-dim p-3 text-xs">
                <p className="font-semibold text-s-amber">Copy it now — it is shown only this once.</p>
                <code className="break-all font-mono text-s-text">{newSecret}</code>
                <button className="ml-2 s-btn-ghost px-2 py-1 text-xs" onClick={() => setNewSecret(null)}>Done</button>
              </div>
            )}
            <ErrorLine>{regen.error ? connectorErrorText(regen.error) : rotate.error ? connectorErrorText(rotate.error) : null}</ErrorLine>
          </Field>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Charge timeout (seconds)" htmlFor="tm-timeout" hint="How long a charge may wait for the card (45–300).">
            <RangeNumberInput id="tm-timeout" min={45} max={300} className="max-w-[140px]" disabled={!canEdit}
              value={s.chargeTimeoutSec} onChange={(n) => setS((p) => ({ ...p, chargeTimeoutSec: n }))}
              onValidChange={(ok) => setBadNums((b) => ({ ...b, chargeTimeoutSec: !ok }))} />
          </Field>
          <Field label="Till checks every (ms)" htmlFor="tm-poll" hint="1000–5000.">
            <RangeNumberInput id="tm-poll" min={1000} max={5000} step={250} className="max-w-[140px]" disabled={!canEdit}
              value={s.pollMs} onChange={(n) => setS((p) => ({ ...p, pollMs: n }))}
              onValidChange={(ok) => setBadNums((b) => ({ ...b, pollMs: !ok }))} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!canEdit || driver === 'none'} checked={s.allowManualRef} onChange={(e) => setS({ ...s, allowManualRef: e.target.checked })} />
          <span>Allow the manual card reference at the till (the fallback when the machine is offline){driver === 'none' && ' — always on while no driver is set'}</span>
        </label>
        {driver === 'test' && (
          <Field label="Test driver behaviour">
            <Select className="s-select max-w-[260px]" disabled={!canEdit} value={s.test?.scenario ?? 'approve'} onChange={(e) => setS({ ...s, test: { scenario: e.target.value } })}>
              {TERMINAL_TEST_SCENARIOS.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
        )}
      </Card>

      <Card title="Card machines" subtitle="One row per machine. The till shows the machines of its own outlet.">
        {rows.length === 0 && <p className="text-xs text-s-muted">No card machines yet.</p>}
        {rows.length > 0 && (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="s-table">
              <thead><tr><th>Label</th><th>Outlet</th><th>Vendor terminal ID</th><th>Active</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id ?? `new-${i}`}>
                    <td><input aria-label="Label" className="s-input w-[150px] text-xs" disabled={!canEdit} value={r.label} maxLength={80} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="Counter 1" /></td>
                    <td>
                      {canEdit ? (
                        <Select aria-label="Outlet" className="s-select min-w-[150px] text-xs" value={r.locationId} onChange={(e) => setRow(i, { locationId: e.target.value })}>
                          <option value="">Pick an outlet…</option>
                          {locations.data.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </Select>
                      ) : locName(r.locationId)}
                    </td>
                    <td><input aria-label="Vendor terminal ID" className="s-input w-[150px] font-mono text-xs" disabled={!canEdit} value={r.terminalId} maxLength={64} onChange={(e) => setRow(i, { terminalId: e.target.value })} /></td>
                    <td><input type="checkbox" aria-label="Active" disabled={!canEdit} checked={r.active} onChange={(e) => setRow(i, { active: e.target.checked })} /></td>
                    <td>{canEdit && <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && <button className="s-btn-secondary" onClick={() => setRows([...rows, { label: '', locationId: '', terminalId: '', active: true }])}>Add card machine</button>}
      </Card>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="s-btn-primary" disabled={save.isPending || invalid || numbersBad || Object.keys(body).length === 0} onClick={async () => {
            // Turning the till button on with the TEST driver (or switching an
            // enabled machine to TEST) means card sales are recorded as paid
            // with no money taken — make the operator say so.
            const testAtTill = enabled && driver === 'test' && (enabled !== t.enabled || driver !== t.driver)
            if (testAtTill && !(await confirm({
              title: 'Turn the TEST card machine on at the till?',
              body: 'Every “Charge on card machine” is approved by the simulator and recorded as a paid card sale — no card is charged and no money moves. Only do this to rehearse, never while trading.',
              confirmLabel: 'Turn on TEST machine', danger: true,
            }))) return
            save.mutate()
          }}>
            {save.isPending ? 'Saving…' : 'Save card machine settings'}
          </button>
          {invalid && <span className="text-xs text-s-muted">Every machine needs a label, an outlet and the vendor&rsquo;s terminal ID.</span>}
          {save.isSuccess && Object.keys(body).length === 0 && <OkLine>Saved.</OkLine>}
          <ErrorLine>{save.error ? connectorErrorText(save.error) : null}</ErrorLine>
        </div>
      )}

      <Card title="Test card machine" subtitle="Asks the processor whether the machine is online. No money moves.">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Machine">
            <Select className="s-select min-w-[180px]" value={testTerminal} onChange={(e) => setTestTerminal(e.target.value)}>
              <option value="">First machine</option>
              {t.settings.terminals.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </Select>
          </Field>
          <button className="s-btn-secondary" disabled={!canEdit || test.isPending || t.driver === 'none'} onClick={() => { setTestResult(null); test.mutate() }}>
            {test.isPending ? 'Testing…' : 'Test card machine'}
          </button>
        </div>
        {testResult && (
          <p className={`text-xs ${testResult.ok ? 'text-s-green' : 'text-s-red'}`}>{testResult.ok ? 'Online' : 'Not ready'} — {testResult.detail} ({testResult.latencyMs} ms)</p>
        )}
        <ErrorLine>{test.error ? connectorErrorText(test.error) : null}</ErrorLine>
        {t.lastTestAt && !testResult && <p className="text-xs text-s-muted">Last test {fmtWhen(t.lastTestAt)}: {t.lastTestOk ? 'online' : 'failed'}{t.lastTestDetail ? ` — ${t.lastTestDetail}` : ''}.</p>}
      </Card>
    </div>
  )
}
