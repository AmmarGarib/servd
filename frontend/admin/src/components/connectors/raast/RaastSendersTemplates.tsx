'use client'
// Raast QR → Banks & templates (spec §6.1–6.2, §6.7).
//
// Templates describe a bank's SMS in servd's own small language — literal
// text plus placeholders — compiled by the server. It is never a regular
// expression. Senders are the allow-list: an SMS from any other sender is
// dropped without its text being stored. Each sender reports on one of the
// company's ledger-linked bank accounts and is read with its templates.
// Each card saves only its own part (PUT /connectors/raast/settings merges).

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  connectorsApi, connectorErrorText, RAAST_NUMBER_SETTINGS,
  type RaastNumberKey, type RaastSender, type RaastSettings, type RaastSettingsPage, type RaastTemplate, type RaastTemplateKind, type RaastTestParseResult,
} from '../../../lib/connectorsApi'
import { Badge, Card, ErrorLine, Field, OkLine, RangeNumberInput } from '../ui'
import { ParseResultView } from './RaastTester'
import { Select } from '@/components/ui/Select'

const PLACEHOLDER_HELP: Array<[string, string]> = [
  ['{amount}', 'The amount: 1188, 1,188.00, PKR 1,188, Rs.1,188/- (required in every template)'],
  ['{ref}', 'The transaction ID / reference (required in money-in templates)'],
  ['{date}', '12-10-2026, 12/10/26, 12-Oct-2026, 2026-10-12'],
  ['{time}', '14:05, 14:05:09, 2:05 PM'],
  ['{account}', 'A masked account like ****1234 or XX-1234 (its last 4 digits are kept)'],
  ['{payer}', 'Up to 60 characters of the sender’s name'],
  ['{*}', 'Skip up to 200 characters of anything (a variable tail)'],
]

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['raast-settings'] })
  void qc.invalidateQueries({ queryKey: ['connectors'] })
}

export function RaastSendersTemplates({ data, canEdit }: { data: RaastSettingsPage; canEdit: boolean }) {
  return (
    <div className="space-y-4">
      <Templates data={data} canEdit={canEdit} />
      <Senders data={data} canEdit={canEdit} />
      <Rules data={data} canEdit={canEdit} />
    </div>
  )
}

// ─── Templates ───────────────────────────────────────────────────────────────

type TplRow = Omit<RaastTemplate, 'id' | 'dateFormat' | 'timeFormat'> & { id?: string; dateFormat: string; timeFormat: string }

function toRow(t: RaastTemplate): TplRow {
  return { id: t.id, label: t.label, kind: t.kind, template: t.template, dateFormat: t.dateFormat ?? '', timeFormat: t.timeFormat ?? '', active: t.active }
}

function fromRow(r: TplRow): Omit<RaastTemplate, 'id'> & { id?: string } {
  return {
    ...(r.id && { id: r.id }),
    label: r.label.trim(),
    kind: r.kind,
    template: r.template,
    ...(r.dateFormat.trim() && { dateFormat: r.dateFormat.trim() }),
    ...(r.timeFormat.trim() && { timeFormat: r.timeFormat.trim() }),
    active: r.active,
  }
}

/** The same rules the server's compiler applies first — so Save is disabled with a reason. */
function templateProblem(r: TplRow): string | null {
  if (!r.label.trim()) return 'needs a name'
  if (!r.template.trim()) return 'is empty'
  if (r.template.length > 500) return 'is longer than 500 characters'
  const low = r.template.toLowerCase()
  if (!low.includes('{amount}')) return 'needs {amount}'
  if (r.kind === 'credit' && !low.includes('{ref}')) return 'is money-in, so it needs {ref}'
  return null
}

function Templates({ data, canEdit }: { data: RaastSettingsPage; canEdit: boolean }) {
  const qc = useQueryClient()
  const saved = data.connector.settings.templates
  const serverKey = JSON.stringify(saved)
  const [rows, setRows] = useState<TplRow[]>(() => saved.map(toRow))
  useEffect(() => { setRows(saved.map(toRow)) }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of data.connector.settings.senders) for (const id of s.templateIds) m.set(id, [...(m.get(id) ?? []), s.senderId])
    return m
  }, [data.connector.settings.senders])
  const dirty = JSON.stringify(rows.map(fromRow)) !== JSON.stringify(saved.map(toRow).map(fromRow))
  const problems = rows.map(templateProblem)
  const firstProblem = problems.findIndex((p) => p !== null)
  const save = useMutation({
    mutationFn: () => connectorsApi.saveRaastSettings({ templates: rows.map(fromRow) }),
    onSuccess: () => invalidate(qc),
  })
  const setRow = (i: number, p: Partial<TplRow>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...p } : x)))

  return (
    <Card title="SMS templates" subtitle="One template per bank SMS format. Copy a real SMS, then replace the parts that change with placeholders. The whole SMS must fit — a partial fit is not a match.">
      {!canEdit && <p className="text-xs text-s-muted">Read-only — the CEO and IT edit templates.</p>}
      <details className="rounded-lg border border-s-border bg-s-surface px-3 py-2 text-xs">
        <summary className="cursor-pointer font-semibold text-s-text">Placeholders</summary>
        <table className="mt-2 w-full text-left">
          <tbody>
            {PLACEHOLDER_HELP.map(([p, d]) => (
              <tr key={p}><td className="whitespace-nowrap pr-3 align-top font-mono text-s-text">{p}</td><td className="text-s-muted">{d}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-s-muted">Other text is matched as written, ignoring capitals; any run of spaces or line breaks matches any other. Each placeholder may appear once. Example:</p>
        <code className="mt-1 block break-all rounded bg-s-bg px-2 py-1 font-mono text-[11px] text-s-text">PKR {'{amount}'} received in A/C {'{account}'} from {'{payer}'} via Raast. Ref {'{ref}'} on {'{date}'} {'{time}'}.{'{*}'}</code>
        <p className="mt-2 text-s-muted">A money-out (debit) template is only there to recognise money leaving the account — servd flags it to finance and never matches it to a bill.</p>
      </details>

      {rows.length === 0 && <p className="text-xs text-s-muted">No templates yet.</p>}
      <div className="space-y-3">
        {rows.map((r, i) => (
          <TemplateEditor key={r.id ?? `new-${i}`} row={r} canEdit={canEdit} problem={problems[i] ?? null}
            usedBy={r.id ? usedBy.get(r.id) ?? [] : []}
            onChange={(p) => setRow(i, p)}
            onRemove={() => setRows(rows.filter((_, j) => j !== i))} />
        ))}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="s-btn-secondary" disabled={rows.length >= 50}
            onClick={() => setRows([...rows, { label: '', kind: 'credit', template: '', dateFormat: '', timeFormat: '', active: true }])}>
            Add template
          </button>
          <button className="s-btn-primary" disabled={!dirty || firstProblem >= 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save templates'}
          </button>
          {firstProblem >= 0 && <span className="text-xs text-s-muted">Template {firstProblem + 1} {problems[firstProblem]}.</span>}
          {save.isSuccess && !dirty && <OkLine>Saved.</OkLine>}
        </div>
      )}
      <ErrorLine>{save.error ? connectorErrorText(save.error) : null}</ErrorLine>
    </Card>
  )
}

function TemplateEditor({ row, canEdit, problem, usedBy, onChange, onRemove }: {
  row: TplRow
  canEdit: boolean
  problem: string | null
  usedBy: string[]
  onChange: (p: Partial<TplRow>) => void
  onRemove: () => void
}) {
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<RaastTestParseResult | null>(null)
  const tryIt = useMutation({
    mutationFn: () => connectorsApi.raastTestParse({ sender: 'TEMPLATE-CHECK', body: sample, templates: [fromRow(row)] }),
    onSuccess: setResult,
  })
  const one = result?.results[0] ?? null
  return (
    <div className="space-y-2 rounded-lg border border-s-border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name">
          <input className="s-input w-[200px] text-xs" disabled={!canEdit} maxLength={80} value={row.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="Meezan Raast credit" />
        </Field>
        <Field label="Kind">
          <Select className="s-select w-[150px] text-xs" disabled={!canEdit} value={row.kind} onChange={(e) => onChange({ kind: e.target.value as RaastTemplateKind })}>
            <option value="credit">Money in (credit)</option>
            <option value="debit">Money out (debit)</option>
          </Select>
        </Field>
        <Field label="Date format" hint="Optional, e.g. DD-MM-YYYY">
          <input className="s-input w-[130px] font-mono text-xs" disabled={!canEdit} maxLength={20} value={row.dateFormat} onChange={(e) => onChange({ dateFormat: e.target.value })} placeholder="DD-MM-YYYY" />
        </Field>
        <Field label="Time format" hint="Optional">
          <input className="s-input w-[110px] font-mono text-xs" disabled={!canEdit} maxLength={20} value={row.timeFormat} onChange={(e) => onChange({ timeFormat: e.target.value })} placeholder="HH:mm" />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-xs">
          <input type="checkbox" disabled={!canEdit} checked={row.active} onChange={(e) => onChange({ active: e.target.checked })} />
          Active
        </label>
        {row.id && usedBy.length > 0 && <Badge tone="info" title="Senders that use this template">Used by {usedBy.join(', ')}</Badge>}
        {canEdit && (
          <button className="s-btn-ghost ml-auto px-2 py-1 text-xs" disabled={usedBy.length > 0}
            title={usedBy.length > 0 ? 'Take it off its senders first (Bank senders below)' : undefined}
            onClick={onRemove}>Remove</button>
        )}
      </div>
      <Field label="Template">
        <textarea className="s-input font-mono text-xs" rows={3} disabled={!canEdit} maxLength={500} value={row.template}
          onChange={(e) => onChange({ template: e.target.value })}
          placeholder="PKR {amount} received in A/C {account} from {payer} via Raast. Ref {ref} on {date} {time}.{*}" />
      </Field>
      {problem && <p className="text-[11px] text-s-amber">This template {problem}.</p>}

      <div className="space-y-2 rounded-lg bg-s-bg p-2">
        <Field label="Try it on a real SMS (nothing is saved)">
          <textarea className="s-input font-mono text-xs" rows={2} maxLength={2000} value={sample} onChange={(e) => { setSample(e.target.value); setResult(null) }}
            placeholder="Paste a bank SMS here" />
        </Field>
        <button className="s-btn-secondary px-2 py-1 text-xs" disabled={!sample.trim() || !row.template.trim() || !row.label.trim() || tryIt.isPending} onClick={() => tryIt.mutate()}>
          {tryIt.isPending ? 'Checking…' : 'Try this template'}
        </button>
        {one && <ParseResultView r={one} />}
        <ErrorLine>{tryIt.error ? connectorErrorText(tryIt.error) : null}</ErrorLine>
      </div>
    </div>
  )
}

// ─── Senders ─────────────────────────────────────────────────────────────────

type SenderRow = Omit<RaastSender, 'id' | 'accountLast4'> & { id?: string; accountLast4: string }

function toSenderRow(s: RaastSender): SenderRow {
  return { id: s.id, senderId: s.senderId, bankAccountId: s.bankAccountId, accountLast4: s.accountLast4 ?? '', templateIds: s.templateIds, active: s.active }
}

function fromSenderRow(r: SenderRow): Omit<RaastSender, 'id'> & { id?: string } {
  return {
    ...(r.id && { id: r.id }),
    senderId: r.senderId.trim(),
    bankAccountId: r.bankAccountId,
    ...(r.accountLast4.trim() && { accountLast4: r.accountLast4.trim() }),
    templateIds: r.templateIds,
    active: r.active,
  }
}

function Senders({ data, canEdit }: { data: RaastSettingsPage; canEdit: boolean }) {
  const qc = useQueryClient()
  const saved = data.connector.settings.senders
  const templates = data.connector.settings.templates
  const accounts = data.receivingAccounts.bankAccounts
  const serverKey = JSON.stringify(saved)
  const [rows, setRows] = useState<SenderRow[]>(() => saved.map(toSenderRow))
  useEffect(() => { setRows(saved.map(toSenderRow)) }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(rows.map(fromSenderRow)) !== JSON.stringify(saved.map(toSenderRow).map(fromSenderRow))

  // Several active entries on one sender must each give the account's last 4.
  const activeBySender = new Map<string, number>()
  for (const r of rows.filter((x) => x.active)) {
    const k = r.senderId.trim().toUpperCase()
    activeBySender.set(k, (activeBySender.get(k) ?? 0) + 1)
  }
  const problemOf = (r: SenderRow): string | null => {
    if (r.senderId.trim().length < 2) return 'needs the SMS sender id or number'
    if (!r.bankAccountId) return 'needs a bank account'
    if (r.templateIds.length === 0) return 'needs at least one template'
    if (r.templateIds.length > 10) return 'can use at most 10 templates'
    if (r.accountLast4 && !/^[0-9]{4}$/.test(r.accountLast4)) return 'account last 4 must be 4 digits'
    if (r.active && (activeBySender.get(r.senderId.trim().toUpperCase()) ?? 0) > 1 && !r.accountLast4) return 'shares its sender with another entry, so it needs the account’s last 4 digits'
    return null
  }
  const problems = rows.map(problemOf)
  const firstProblem = problems.findIndex((p) => p !== null)
  const save = useMutation({
    mutationFn: () => connectorsApi.saveRaastSettings({ senders: rows.map(fromSenderRow) }),
    onSuccess: () => invalidate(qc),
  })
  const setRow = (i: number, p: Partial<SenderRow>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.id === id)
    return a ? `${a.name}${a.last4 ? ` ·${a.last4}` : ''}` : 'Not an active linked account'
  }

  return (
    <Card title="Bank senders (allow-list)" subtitle="Only SMS from these senders are stored and read. Everything else that reaches servd is counted and dropped without its text.">
      {!canEdit && <p className="text-xs text-s-muted">Read-only — the CEO and IT edit senders.</p>}
      {accounts.length === 0 && (
        <p className="text-xs text-s-amber">The company has no active bank account linked to the chart of accounts yet — finance sets one up in Finance → Bank accounts.</p>
      )}
      {templates.length === 0 && <p className="text-xs text-s-muted">Save at least one template first; a sender is read with its templates.</p>}
      {rows.length === 0 && <p className="text-xs text-s-muted">No senders yet.</p>}
      {rows.length > 0 && (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="s-table">
            <thead><tr><th>Sender</th><th>Bank account</th><th>Account last 4</th><th>Templates</th><th>Active</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id ?? `new-${i}`}>
                  <td>
                    <input aria-label="Sender" className="s-input w-[150px] font-mono text-xs" disabled={!canEdit} maxLength={40} value={r.senderId}
                      onChange={(e) => setRow(i, { senderId: e.target.value })} placeholder="MEEZANBNK or 8079" />
                    {problems[i] && <p className="mt-1 max-w-[220px] text-[11px] text-s-amber">This sender {problems[i]}.</p>}
                  </td>
                  <td>
                    {canEdit ? (
                      <Select aria-label="Bank account" className="s-select min-w-[180px] text-xs" value={r.bankAccountId} onChange={(e) => setRow(i, { bankAccountId: e.target.value })}>
                        <option value="">Pick an account…</option>
                        {r.bankAccountId && !accounts.some((a) => a.id === r.bankAccountId) && <option value={r.bankAccountId}>{accountLabel(r.bankAccountId)}</option>}
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.bankName ? ` — ${a.bankName}` : ''}{a.last4 ? ` ·${a.last4}` : ''}</option>)}
                      </Select>
                    ) : <span className="text-xs">{accountLabel(r.bankAccountId)}</span>}
                  </td>
                  <td>
                    <input aria-label="Account last 4" inputMode="numeric" className="s-input w-[80px] font-mono text-xs" disabled={!canEdit} maxLength={4} value={r.accountLast4}
                      onChange={(e) => setRow(i, { accountLast4: e.target.value.replace(/[^0-9]/g, '') })} placeholder="1234" />
                  </td>
                  <td>
                    <div className="flex max-w-[260px] flex-wrap gap-x-3 gap-y-1">
                      {templates.map((t) => (
                        <label key={t.id} className="flex items-center gap-1 text-xs">
                          <input type="checkbox" disabled={!canEdit} checked={r.templateIds.includes(t.id)}
                            onChange={(e) => setRow(i, { templateIds: e.target.checked ? [...r.templateIds, t.id] : r.templateIds.filter((x) => x !== t.id) })} />
                          <span className={t.active ? '' : 'text-s-muted'}>{t.label}{t.kind === 'debit' ? ' (out)' : ''}{t.active ? '' : ' (inactive)'}</span>
                        </label>
                      ))}
                    </div>
                  </td>
                  <td><input type="checkbox" aria-label="Active" disabled={!canEdit} checked={r.active} onChange={(e) => setRow(i, { active: e.target.checked })} /></td>
                  <td>{canEdit && <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="s-btn-secondary" disabled={rows.length >= 20 || templates.length === 0}
            onClick={() => setRows([...rows, { senderId: '', bankAccountId: accounts.length === 1 ? accounts[0]!.id : '', accountLast4: '', templateIds: [], active: true }])}>
            Add sender
          </button>
          <button className="s-btn-primary" disabled={!dirty || firstProblem >= 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save senders'}
          </button>
          {save.isSuccess && !dirty && <OkLine>Saved.</OkLine>}
        </div>
      )}
      <p className="text-[11px] text-s-muted">servd stores the sender in one form: capitals with punctuation removed (HBL-Alert → HBLALERT), phone numbers as 92XXXXXXXXXX.</p>
      <ErrorLine>{save.error ? connectorErrorText(save.error) : null}</ErrorLine>
    </Card>
  )
}

// ─── Matching rules ──────────────────────────────────────────────────────────


function Rules({ data, canEdit }: { data: RaastSettingsPage; canEdit: boolean }) {
  const qc = useQueryClient()
  const saved = data.connector.settings
  const pick = (s: RaastSettings) => ({
    ...Object.fromEntries(RAAST_NUMBER_SETTINGS.map((x) => [x.key, s[x.key]])) as Record<RaastNumberKey, number>,
    ignoreKeywords: s.ignoreKeywords.join('\n'),
  })
  const serverKey = JSON.stringify(pick(saved))
  const [draft, setDraft] = useState(() => pick(saved))
  useEffect(() => { setDraft(pick(saved)) }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const [bad, setBad] = useState<Record<string, boolean>>({})
  const keywords = draft.ignoreKeywords.split('\n').map((k) => k.trim()).filter(Boolean)
  const kwBad = keywords.length > 30 || keywords.some((k) => k.length > 40)
  const lengthsBad = (draft['refMinLength'] ?? 0) > (draft['refMaxLength'] ?? 0)
  const patch: Partial<Record<RaastNumberKey, number>> & { ignoreKeywords?: string[] } = {}
  for (const x of RAAST_NUMBER_SETTINGS) if (draft[x.key] !== saved[x.key]) patch[x.key] = draft[x.key]
  if (JSON.stringify(keywords) !== JSON.stringify(saved.ignoreKeywords)) patch.ignoreKeywords = keywords
  const save = useMutation({
    mutationFn: () => connectorsApi.saveRaastSettings(patch),
    onSuccess: () => invalidate(qc),
  })
  const anyBad = Object.values(bad).some(Boolean) || kwBad || lengthsBad

  return (
    <Card title="Matching rules" subtitle="The defaults suit most banks. A bill is finished by an SMS only when exactly one waiting bill of the same amount, on the same account, fits these windows.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {RAAST_NUMBER_SETTINGS.map((x) => (
          <Field key={x.key} label={x.label} htmlFor={`rr-${x.key}`} hint={`${x.hint} (${x.min}–${x.max})`}>
            <RangeNumberInput id={`rr-${x.key}`} min={x.min} max={x.max} className="max-w-[120px]" disabled={!canEdit}
              value={draft[x.key]} onChange={(n) => setDraft((d) => ({ ...d, [x.key]: n }))}
              onValidChange={(ok) => setBad((b) => ({ ...b, [x.key]: !ok }))} />
          </Field>
        ))}
      </div>
      {lengthsBad && <p className="text-[11px] text-s-red">The shortest reference cannot be longer than the longest.</p>}
      <Field label="Never store an SMS containing" htmlFor="rr-kw" hint="One word or phrase per line (up to 30). An SMS with any of these is dropped without its text being stored — keep OTP, PIN and password here.">
        <textarea id="rr-kw" className="s-input max-w-[360px] font-mono text-xs" rows={5} disabled={!canEdit} value={draft.ignoreKeywords}
          onChange={(e) => setDraft((d) => ({ ...d, ignoreKeywords: e.target.value }))} />
      </Field>
      {kwBad && <p className="text-[11px] text-s-red">At most 30 lines, each up to 40 characters.</p>}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="s-btn-primary" disabled={Object.keys(patch).length === 0 || anyBad || save.isPending} onClick={() => {
            const dropped = saved.ignoreKeywords.filter((k) => !keywords.some((x) => x.toLowerCase() === k.toLowerCase()))
            if (dropped.length > 0 && !confirm(`Stop ignoring: ${dropped.join(', ')}?\n\nSMS containing these will be stored if they come from a listed bank sender.`)) return
            save.mutate()
          }}>
            {save.isPending ? 'Saving…' : 'Save rules'}
          </button>
          {save.isSuccess && Object.keys(patch).length === 0 && <OkLine>Saved.</OkLine>}
        </div>
      )}
      <ErrorLine>{save.error ? connectorErrorText(save.error) : null}</ErrorLine>
    </Card>
  )
}
