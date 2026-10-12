'use client'
// Raast QR → Counter phones (spec §6.7, amendment S2).
//
// A device is the counter phone holding the SIM the bank texts, running an
// SMS-forwarder app. Its token is shown ONCE (add / rotate); the CEO can
// reveal it again (audited). Rotating kills the old token at once. The token
// belongs in the Authorization header; "Allow token in the URL" is a
// per-device fallback, OFF by default, for forwarders that cannot set
// headers — a URL lands in proxy / Cloudflare / app logs.

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  connectorsApi, connectorErrorText,
  type RaastDevice, type RaastDeviceToken, type RaastSettingsPage,
} from '../../../lib/connectorsApi'
import { useCompanyLocations } from '../PosIdsTable'
import { Badge, Card, ErrorLine, Field, Modal, fmtAge, fmtWhen } from '../ui'

export const PATH_TOKEN_WARNING =
  'The token will sit in the web address. Proxies, Cloudflare and the forwarder app may keep web addresses in their logs, and anyone who reads such a log can send fake bank SMS for this company. servd masks it in its own logs. Use this only when the forwarder app cannot set an Authorization header, and rotate the token if the phone is lost or replaced.'

const DAY_MS = 86_400_000

export function RaastDevices({ data, canEdit, isCeo, activeTenantId }: {
  data: RaastSettingsPage
  canEdit: boolean
  isCeo: boolean
  activeTenantId: string | null
}) {
  const qc = useQueryClient()
  const locations = useCompanyLocations(activeTenantId)
  const locName = (id: string | null) => (id ? locations.data.find((l) => l.id === id)?.name ?? 'Another outlet' : 'Every outlet')
  const [shown, setShown] = useState<{ token: RaastDeviceToken; why: 'added' | 'rotated' | 'revealed' } | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<RaastDevice | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['raast-settings'] })
    void qc.invalidateQueries({ queryKey: ['connectors'] })
  }

  const rotate = useMutation({
    mutationFn: (id: string) => connectorsApi.rotateRaastDevice(id),
    onSuccess: (r) => { setShown({ token: r, why: 'rotated' }); refresh() },
  })
  const reveal = useMutation({
    mutationFn: (id: string) => connectorsApi.revealRaastDevice(id),
    onSuccess: (r) => setShown({ token: r, why: 'revealed' }),
  })
  const toggle = useMutation({
    mutationFn: (d: RaastDevice) => connectorsApi.updateRaastDevice(d.id, { active: !d.active }),
    onSuccess: refresh,
  })

  const now = Date.now()
  return (
    <div className="space-y-4">
      {shown && <TokenPanel shown={shown} onDone={() => setShown(null)} />}

      <Card title="Counter phones"
        subtitle="Each phone holds the SIM the bank texts and runs an SMS forwarder that posts every bank SMS to servd. Set the forwarder to send only the bank's sender."
        actions={canEdit ? <button className="s-btn-primary" disabled={!data.secretKeyConfigured} onClick={() => setAdding(true)}>Add counter phone</button> : undefined}>
        {!canEdit && <p className="text-xs text-s-muted">Read-only — the CEO and IT manage counter phones.</p>}
        {data.devices.length === 0 && <p className="text-xs text-s-muted">No counter phones yet.</p>}
        {data.devices.length > 0 && (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="s-table">
              <thead>
                <tr><th>Phone</th><th>Outlet</th><th>Status</th><th>Last heard</th><th>Last bank SMS</th><th>Ignored</th><th>Token</th><th /></tr>
              </thead>
              <tbody>
                {data.devices.map((d) => {
                  const quiet = d.active && (!d.lastSeenAt || now - new Date(d.lastSeenAt).getTime() > DAY_MS)
                  return (
                    <tr key={d.id}>
                      <td className="text-sm text-s-text">{d.label}</td>
                      <td className="text-xs">{locName(d.locationId)}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={d.active ? 'ok' : 'muted'}>{d.active ? 'Active' : 'Switched off'}</Badge>
                          {quiet && <Badge tone="warn" title="Not heard from in 24 hours">Quiet</Badge>}
                          {d.allowPathToken && <Badge tone="warn" title={PATH_TOKEN_WARNING}>Token in URL allowed</Badge>}
                        </div>
                      </td>
                      <td className="text-xs" title={fmtWhen(d.lastSeenAt)}>{d.lastSeenAt ? `${fmtAge(d.lastSeenAt, now)} ago` : 'Never'}</td>
                      <td className="text-xs" title={fmtWhen(d.lastSmsAt)}>{d.lastSmsAt ? `${fmtAge(d.lastSmsAt, now)} ago` : 'None yet'}</td>
                      <td className="text-xs" title={d.lastIgnoredAt ? `Last ignored ${fmtWhen(d.lastIgnoredAt)} — the text of an ignored SMS is never stored` : 'SMS from senders not on the list (or with a one-time code) — never stored'}>
                        {d.ignoredCount}
                      </td>
                      <td className="font-mono text-[11px]">{d.tokenHint}{d.rotatedAt && <span className="block font-sans text-s-muted">rotated {fmtWhen(d.rotatedAt)}</span>}</td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-1">
                          {canEdit && <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(d)}>Edit</button>}
                          {canEdit && (
                            <button className="s-btn-ghost px-2 py-1 text-xs" disabled={toggle.isPending}
                              onClick={() => { if (!d.active || confirm(`Switch off ${d.label}? Its token stops working until you switch it back on.`)) toggle.mutate(d) }}>
                              {d.active ? 'Switch off' : 'Switch on'}
                            </button>
                          )}
                          {canEdit && (
                            <button className="s-btn-secondary px-2 py-1 text-xs" disabled={rotate.isPending || !data.secretKeyConfigured}
                              onClick={() => { if (confirm(`Issue a new token for ${d.label}? The old token stops working at once — put the new one into the forwarder straight away.`)) rotate.mutate(d.id) }}>
                              Rotate token
                            </button>
                          )}
                          {isCeo && (
                            <button className="s-btn-ghost px-2 py-1 text-xs" disabled={reveal.isPending}
                              onClick={() => { if (confirm(`Show the token of ${d.label} again? This is recorded in the audit log.`)) reveal.mutate(d.id) }}>
                              Reveal
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <ErrorLine>
          {rotate.error ? connectorErrorText(rotate.error) : reveal.error ? connectorErrorText(reveal.error) : toggle.error ? connectorErrorText(toggle.error) : null}
        </ErrorLine>
      </Card>

      <ForwarderHelp />

      {adding && (
        <DeviceForm title="Add counter phone" locations={locations.data} onClose={() => setAdding(false)}
          onSaved={(r) => { setAdding(false); if (r) setShown({ token: r, why: 'added' }); refresh() }} />
      )}
      {editing && (
        <DeviceForm title={`Edit ${editing.label}`} device={editing} locations={locations.data} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }} />
      )}
    </div>
  )
}

function DeviceForm({ title, device, locations, onClose, onSaved }: {
  title: string
  device?: RaastDevice
  locations: Array<{ id: string; name: string }>
  onClose: () => void
  onSaved: (r: RaastDeviceToken | null) => void
}) {
  const [label, setLabel] = useState(device?.label ?? '')
  const [locationId, setLocationId] = useState(device?.locationId ?? '')
  const [allowPathToken, setAllowPathToken] = useState(device?.allowPathToken ?? false)
  const save = useMutation({
    mutationFn: async (): Promise<RaastDeviceToken | null> => {
      if (!device) return connectorsApi.addRaastDevice({ label: label.trim(), locationId: locationId || null, allowPathToken })
      const body: { label?: string; locationId?: string | null; allowPathToken?: boolean } = {}
      if (label.trim() !== device.label) body.label = label.trim()
      if ((locationId || null) !== device.locationId) body.locationId = locationId || null
      if (allowPathToken !== device.allowPathToken) body.allowPathToken = allowPathToken
      if (Object.keys(body).length > 0) await connectorsApi.updateRaastDevice(device.id, body)
      return null
    },
    onSuccess: onSaved,
  })
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Label" htmlFor="rd-label" hint="Which phone this is, e.g. “Clifton counter phone”.">
        <input id="rd-label" className="s-input" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Outlet" htmlFor="rd-loc" hint="The till shows this phone's unmatched bank SMS only on that outlet's drawers. Leave it on every outlet when one SIM serves them all.">
        <select id="rd-loc" className="s-select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Every outlet</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={allowPathToken} onChange={(e) => setAllowPathToken(e.target.checked)} />
          <span>Allow the token in the URL (only for forwarders that cannot set an Authorization header)</span>
        </label>
        {allowPathToken && (
          <p role="alert" className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-[11px] text-s-text">{PATH_TOKEN_WARNING}</p>
        )}
        {device && allowPathToken && !device.allowPathToken && (
          <p className="text-[11px] text-s-muted">The address with the token is the posting address followed by “/” and the token you copied when the phone was added. Rotate the token if you no longer have it.</p>
        )}
      </div>
      {!device && <p className="text-xs text-s-muted">The token is shown once, right after you add the phone. Have the forwarder app open.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className="s-btn-primary" disabled={!label.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : device ? 'Save' : 'Add and show the token'}
        </button>
        <button className="s-btn-ghost" onClick={onClose}>Cancel</button>
      </div>
      <ErrorLine>{save.error ? connectorErrorText(save.error) : null}</ErrorLine>
    </Modal>
  )
}

/** The one-time token, with what to put into the forwarder. */
function TokenPanel({ shown, onDone }: { shown: { token: RaastDeviceToken; why: 'added' | 'rotated' | 'revealed' }; onDone: () => void }) {
  const t = shown.token
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-s-amber/40 bg-s-amber-dim px-4 py-3">
      <div>
        <p className="text-sm font-bold text-s-amber">
          {shown.why === 'revealed' ? `Token of ${t.device.label}` : `New token for ${t.device.label}`} — copy it now, it is shown only this once
        </p>
        <p className="text-xs text-s-text">
          {shown.why === 'rotated' && 'The old token has stopped working. '}
          Put these into the forwarder app on the phone. Do not send the token by chat or email.
        </p>
      </div>
      <CopyRow label="Posting address (POST)" value={t.postUrl} />
      <CopyRow label="Header" value={t.header} />
      <CopyRow label="Token" value={t.token} />
      {t.pathUrl && (
        <div className="space-y-1">
          <CopyRow label="Address with the token (only if the app cannot set headers)" value={t.pathUrl} />
          <p className="text-[11px] text-s-text">{PATH_TOKEN_WARNING}</p>
        </div>
      )}
      <button className="s-btn-secondary" onClick={onDone}>I have copied it</button>
    </div>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-s-muted">{label}</p>
      <div className="flex items-start gap-2">
        <code className="flex-1 break-all rounded bg-s-surface px-2 py-1 font-mono text-[11px] text-s-text">{value}</code>
        <button className="s-btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => undefined)
        }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}

const EXAMPLE = `{ "from": "MEEZANBNK", "text": "PKR 1,188.00 received in A/C ****1234 from ALI KHAN via Raast. Ref FT2610881234 on 12-10-2026 14:05.", "receivedAt": 1760259900000 }`

function ForwarderHelp() {
  return (
    <Card title="Setting up the forwarder" subtitle="Full runbook: docs/raast-sms-forwarder.md.">
      <ol className="list-decimal space-y-1 pl-5 text-xs text-s-text">
        <li>Use a phone that stays at the counter with the SIM the bank sends credit SMS to (the merchant account&rsquo;s registered number).</li>
        <li>Install an SMS forwarder app that can post over HTTPS with a JSON or form body and set a header.</li>
        <li>Filter it to the bank&rsquo;s sender only (the short code or number in Banks &amp; templates). Anything else that reaches servd is dropped without being stored.</li>
        <li>Set it to <strong>POST</strong> to the posting address with the <code className="font-mono">Authorization: Bearer …</code> header shown when the phone was added.</li>
        <li>Send a test: the phone&rsquo;s &ldquo;Last heard&rdquo; updates. Leave it running for a day while matching is off and check the Bank SMS log.</li>
      </ol>
      <div className="space-y-1 text-xs text-s-muted">
        <p>Field names servd reads (any case): sender — <code className="font-mono">from</code>, <code className="font-mono">sender</code>, <code className="font-mono">address</code>, <code className="font-mono">phone</code>, <code className="font-mono">number</code>, <code className="font-mono">originatingAddress</code>; text — <code className="font-mono">text</code>, <code className="font-mono">body</code>, <code className="font-mono">message</code>, <code className="font-mono">msg</code>, <code className="font-mono">content</code>, <code className="font-mono">sms</code>; time (optional) — <code className="font-mono">receivedAt</code>, <code className="font-mono">timestamp</code>, <code className="font-mono">time</code>, <code className="font-mono">date</code> (epoch ms / seconds or ISO).</p>
        <p>Example body:</p>
        <code className="block break-all rounded bg-s-bg px-2 py-1 font-mono text-[11px] text-s-text">{EXAMPLE}</code>
      </div>
    </Card>
  )
}
