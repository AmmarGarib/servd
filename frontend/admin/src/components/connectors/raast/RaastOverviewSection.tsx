'use client'
// Raast QR → Overview: is bank-SMS matching on, what is waiting, what stops
// the CEO switching it on, and the switch itself (CEO on, CEO/IT off).

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { connectorsApi, connectorErrorText, missingFrom, type RaastSettingsPage } from '../../../lib/connectorsApi'
import { Badge, Card, ConfirmPhrase, ErrorLine, OkLine, fmtWhen } from '../ui'

type Go = (s: 'overview' | 'devices' | 'banks' | 'tester' | 'log' | 'accounts') => void

export function RaastOverviewSection({ data, companyName, canEdit, isCeo, onGo }: {
  data: RaastSettingsPage
  companyName: string
  canEdit: boolean
  isCeo: boolean
  onGo: Go
}) {
  const qc = useQueryClient()
  const on = data.connector.smsMatching
  const c = data.counts
  const [phrase, setPhrase] = useState('')
  const [offNote, setOffNote] = useState<string | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['raast-settings'] })
    void qc.invalidateQueries({ queryKey: ['connectors'] })
  }
  const smsOn = useMutation({
    mutationFn: connectorsApi.raastSmsOn,
    onSuccess: () => { setPhrase(''); refresh() },
  })
  const smsOff = useMutation({
    mutationFn: connectorsApi.raastSmsOff,
    onSuccess: (r) => {
      setPhrase('')
      setOffNote(r.awaiting > 0
        ? `Switched off. ${r.awaiting} Raast request${r.awaiting === 1 ? ' is' : 's are'} still waiting at a till — the cashier confirms each by typing the reference, or it expires.`
        : 'Switched off.')
      refresh()
    },
  })
  const notReady = smsOn.error ? missingFrom(smsOn.error) : []
  const missing = notReady.length > 0 ? notReady : data.readiness.missing

  return (
    <div className="space-y-4">
      <Card
        title="Bank-SMS matching"
        subtitle={<>For <strong className="text-s-text">{companyName}</strong>. A counter phone forwards the bank&rsquo;s credit SMS to servd, which finishes a waiting Raast bill only when exactly one bill fits — it never guesses.</>}
        actions={<Badge tone={on ? 'ok' : 'muted'}>{on ? 'On' : 'Off'}</Badge>}>
        {on ? (
          <p className="text-xs text-s-text">
            On{data.connector.smsOnSince ? ` since ${fmtWhen(data.connector.smsOnSince)}` : ''}. When a customer pays, the till waits for the bank SMS and completes the bill by itself. A cashier can still type the reference by hand; servd then checks it against the SMS.
          </p>
        ) : (
          <p className="text-xs text-s-text">
            Off. The till still takes Raast QR: the cashier checks the money on the counter phone, types the bank reference and ticks &ldquo;I saw it arrive&rdquo;.
            Bank SMS that arrive while matching is off are still read and logged as &ldquo;Read (matching off)&rdquo;, so you can check your templates on real messages — they never pay a bill.
          </p>
        )}
        <ul className="list-disc space-y-1 pl-5 text-xs text-s-muted">
          <li>Cashiers check the money on the counter phone (bank SMS or merchant app), never the customer&rsquo;s screen — fake payment screenshots are common.</li>
          <li>Every Raast receipt stays provisional until finance matches it to a bank-statement line (Finance → Reconciliation → Raast).</li>
          <li>Only SMS from the bank senders you list are stored. One-time codes, PINs and passwords are never stored.</li>
          <li>servd never logs in to internet banking.</li>
        </ul>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Count label="Waiting at a till" value={c.awaiting} />
          <Count label="Provisional (not on a statement yet)" value={c.provisional} />
          <Count label="Receipts needing attention" value={c.needsAttention} tone={c.needsAttention > 0 ? 'bad' : undefined} />
          <Count label="Bank SMS with no single bill" value={c.unmatchedAlerts} tone={c.unmatchedAlerts > 0 ? 'warn' : undefined} onClick={() => onGo('log')} />
          <Count label="Not understood (24 h)" value={c.unparsed24h} tone={c.unparsed24h > 0 ? 'warn' : undefined} onClick={() => onGo('log')} />
        </div>
        {c.unparsed24h > 0 && (
          <p className="text-xs text-s-amber">
            Some bank SMS from a listed sender could not be read. Open the Bank SMS log, copy one into the Tester and adjust the template.
          </p>
        )}
      </Card>

      {!on && (
        <Card title="Ready to switch on?" subtitle="The CEO switches bank-SMS matching on once every item below is done.">
          {missing.length === 0 ? (
            <OkLine>Everything the readiness check needs is in place.</OkLine>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {missing.map((m) => (
                <li key={m} className="flex items-start gap-2">
                  <span aria-hidden className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-s-amber" />
                  <span className="text-s-text">{m}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => onGo('devices')}>Counter phones</button>
            <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => onGo('banks')}>Banks &amp; templates</button>
            <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => onGo('accounts')}>Receiving accounts</button>
          </div>

          {isCeo ? (
            <div className="space-y-2 border-t border-s-border pt-3">
              <ConfirmPhrase phrase="SMS ON" value={phrase} onChange={setPhrase} />
              <button className="s-btn-primary" disabled={phrase !== 'SMS ON' || smsOn.isPending} onClick={() => smsOn.mutate()}>
                {smsOn.isPending ? 'Switching on…' : 'Switch bank-SMS matching on'}
              </button>
              {smsOn.error && notReady.length === 0 && <ErrorLine>{connectorErrorText(smsOn.error)}</ErrorLine>}
              {notReady.length > 0 && <ErrorLine>Not switched on — the list above is what is still missing.</ErrorLine>}
            </div>
          ) : (
            <p className="text-xs text-s-muted">Only the CEO can switch bank-SMS matching on.</p>
          )}
        </Card>
      )}

      {on && canEdit && (
        <Card title="Switch off" subtitle="Bills already waiting for an SMS stay open: the cashier types the reference, or the request expires. SMS keep being logged.">
          <ConfirmPhrase phrase="SMS OFF" value={phrase} onChange={setPhrase} />
          <button className="s-btn-danger" disabled={phrase !== 'SMS OFF' || smsOff.isPending} onClick={() => smsOff.mutate()}>
            {smsOff.isPending ? 'Switching off…' : 'Switch bank-SMS matching off'}
          </button>
          <ErrorLine>{smsOff.error ? connectorErrorText(smsOff.error) : null}</ErrorLine>
        </Card>
      )}
      {offNote && <OkLine>{offNote}</OkLine>}
    </div>
  )
}

function Count({ label, value, tone, onClick }: { label: string; value: number; tone?: 'warn' | 'bad'; onClick?: () => void }) {
  const cls = tone === 'bad' ? 'text-s-red' : tone === 'warn' ? 'text-s-amber' : 'text-s-text'
  const inner = (
    <>
      <span className={`block text-lg font-bold ${cls}`}>{value}</span>
      <span className="block text-[11px] text-s-muted">{label}</span>
    </>
  )
  return onClick ? (
    <button onClick={onClick} className="rounded-lg border border-s-border bg-s-surface px-3 py-2 text-left hover:border-primary">{inner}</button>
  ) : (
    <div className="rounded-lg border border-s-border bg-s-surface px-3 py-2">{inner}</div>
  )
}
