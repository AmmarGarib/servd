'use client'
// Raast QR → Tester: paste a real bank SMS and its sender, and see what the
// SAVED set-up would do with it — is the sender on the list, would an ignore
// keyword drop it, which template reads it and what it reads. Writes nothing
// (POST /connectors/raast/test-parse).

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { connectorsApi, connectorErrorText, type RaastSettingsPage, type RaastTestParseResult } from '../../../lib/connectorsApi'
import { fmtPkr } from '../../../lib/money'
import { Badge, Card, ErrorLine, Field, fmtWhen } from '../ui'

type OneResult = RaastTestParseResult['results'][number]

const SOURCE_LABEL: Record<string, string> = {
  sms: 'from the SMS',
  forwarder: 'from the phone (the SMS had none)',
  server: 'servd’s clock (no time in the SMS or from the phone)',
}

/** One template's verdict on one SMS. */
export function ParseResultView({ r }: { r: OneResult }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-s-text">{r.label}</span>
        <Badge tone={r.matched ? 'ok' : 'muted'}>{r.matched ? 'Reads it' : 'Does not fit'}</Badge>
        {r.kind === 'debit' && <Badge tone="info">Money out</Badge>}
        {!r.active && <Badge tone="muted">Inactive</Badge>}
      </div>
      {r.fields && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-s-muted">Amount</dt><dd className="text-s-text">{fmtPkr(r.fields.amountCents)}</dd>
          <dt className="text-s-muted">Reference</dt>
          <dd className="text-s-text">
            <span className="font-mono">{r.fields.bankRef ?? '—'}</span>
            {r.fields.bankRef && !r.fields.refValid && <span className="ml-2 text-s-amber">not a valid reference — this SMS would be marked “Not understood”</span>}
          </dd>
          <dt className="text-s-muted">When</dt>
          <dd className="text-s-text">{fmtWhen(r.fields.occurredAt)}{r.fields.occurredAtSource ? ` (${SOURCE_LABEL[r.fields.occurredAtSource] ?? r.fields.occurredAtSource})` : ''}</dd>
          <dt className="text-s-muted">Account</dt><dd className="text-s-text">{r.fields.accountLast4 ? `…${r.fields.accountLast4}` : '—'}</dd>
          <dt className="text-s-muted">Payer</dt><dd className="text-s-text">{r.fields.payer ?? '—'}</dd>
        </dl>
      )}
      {r.problems.length > 0 && (
        <ul className="list-disc pl-5 text-s-amber">
          {r.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  )
}

export function RaastTester({ data }: { data: RaastSettingsPage }) {
  const [sender, setSender] = useState(data.connector.settings.senders[0]?.senderId ?? '')
  const [body, setBody] = useState('')
  const [result, setResult] = useState<RaastTestParseResult | null>(null)
  const run = useMutation({
    mutationFn: () => connectorsApi.raastTestParse({ sender: sender.trim(), body }),
    onSuccess: setResult,
  })
  const readers = result?.results.filter((r) => r.matched && r.active) ?? []

  return (
    <Card title="Tester" subtitle="Paste a bank SMS exactly as the phone shows it. servd checks it against the saved senders and templates. Nothing is stored and no bill is touched.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_1fr]">
        <Field label="Sender" htmlFor="rt-sender" hint="The bank’s short code or number, as the phone shows it.">
          <input id="rt-sender" className="s-input font-mono text-xs" maxLength={64} value={sender} onChange={(e) => { setSender(e.target.value); setResult(null) }} placeholder="MEEZANBNK" />
        </Field>
        <Field label="SMS text" htmlFor="rt-body">
          <textarea id="rt-body" className="s-input font-mono text-xs" rows={4} maxLength={2000} value={body} onChange={(e) => { setBody(e.target.value); setResult(null) }} />
        </Field>
      </div>
      <button className="s-btn-primary" disabled={!sender.trim() || !body.trim() || run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? 'Checking…' : 'Check this SMS'}
      </button>
      <ErrorLine>{run.error ? connectorErrorText(run.error) : null}</ErrorLine>

      {result && (
        <div className="space-y-3 border-t border-s-border pt-3">
          <div className="space-y-1 text-xs">
            {result.senderAllowed
              ? <p className="text-success">Sender {result.sender} is on the list — servd would store and read this SMS.</p>
              : <p className="text-s-amber">Sender {result.sender} is not on the list (or switched off) — servd would drop this SMS without storing it. Below, every template is tried anyway.</p>}
            {result.ignoredByKeyword && <p className="text-s-amber">It contains an ignore keyword — servd would drop it without storing it, whatever the sender.</p>}
            {result.senderAllowed && !result.ignoredByKeyword && (
              readers.length === 1
                ? <p className="text-success">Exactly one active template reads it.</p>
                : readers.length === 0
                  ? <p className="text-s-amber">No active template reads it — it would be logged as “Not understood” and IT is told.</p>
                  : <p className="text-s-amber">{readers.length} active templates read it — servd uses the first one in the list. Make the templates tell them apart.</p>
            )}
          </div>
          {result.results.length === 0 && <p className="text-xs text-s-muted">No templates to try — add one in Banks &amp; templates.</p>}
          {result.results.map((r) => (
            <div key={r.templateId} className="rounded-lg border border-s-border p-3"><ParseResultView r={r} /></div>
          ))}
        </div>
      )}
    </Card>
  )
}
