'use client'
// POS connector → Raast QR tab (Raast spec §8 F2, D5–D7, amendment S2).
//
// Raast QR is a till tender (Cash, Card – Keenu, Raast QR). The cashier
// checks the money on the COUNTER phone (bank SMS / merchant app), never the
// customer's screen, and types the bank reference. A Raast receipt stays
// provisional until finance matches it to a bank-statement line.
//
// This tab is IT's half: bank-SMS matching for the ACTIVE company — a
// counter phone forwards the bank's SMS to servd, which finishes a waiting
// bill only when exactly one bill fits (never a guess). It is OFF per company
// until the CEO switches it on after the readiness check. Sections:
//   Overview          status, counts, readiness, the CEO's switch
//   Counter phones    devices, one-time token, forwarder instructions
//   Banks & templates sender allow-list, SMS templates (+ inline tester), rules
//   Tester            try a real SMS against the saved set-up (writes nothing)
//   Bank SMS log      every stored SMS and what servd did with it
//   Receiving accounts read-only — finance sets them in Finance → Bank accounts
// Management reads it; admin + IT configure it; the CEO alone switches SMS
// matching on and reveals a device token again. No new module id (api_pos).

import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import { connectorErrorText, useRaastSettings } from '../../lib/connectorsApi'
import { Banner } from './ui'
import { RaastOverviewSection } from './raast/RaastOverviewSection'
import { RaastDevices } from './raast/RaastDevices'
import { RaastSendersTemplates } from './raast/RaastSendersTemplates'
import { RaastTester } from './raast/RaastTester'
import { RaastSmsLog } from './raast/RaastSmsLog'
import { RaastAccounts } from './raast/RaastAccounts'

type Section = 'overview' | 'devices' | 'banks' | 'tester' | 'log' | 'accounts'
const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'devices', label: 'Counter phones' },
  { key: 'banks', label: 'Banks & templates' },
  { key: 'tester', label: 'Tester' },
  { key: 'log', label: 'Bank SMS log' },
  { key: 'accounts', label: 'Receiving accounts' },
]

export function RaastSetup({ companyName, canEdit, isCeo, activeTenantId }: {
  companyName: string
  canEdit: boolean
  isCeo: boolean
  activeTenantId: string | null
}) {
  const { data, error, isLoading } = useRaastSettings({ refetchMs: 15_000 })
  const [section, setSection] = useState<Section>('overview')
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('raast') as Section | null
    if (s && SECTIONS.some((x) => x.key === s)) setSection(s)
  }, [])
  function go(s: Section) {
    setSection(s)
    const u = new URL(window.location.href)
    u.searchParams.set('raast', s)
    window.history.replaceState(null, '', u.toString())
  }

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-1.5" aria-label="Raast QR sections">
        {SECTIONS.map((s) => (
          <button key={s.key} onClick={() => go(s.key)} aria-pressed={section === s.key}
            className={`rounded-full border px-3 py-1 text-xs ${section === s.key ? 'border-accent bg-accent/20 font-semibold text-s-text' : 'border-s-border text-s-muted hover:text-s-text'}`}>
            {s.label}
          </button>
        ))}
      </nav>

      {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      {error && (
        <Banner tone="bad" title={error instanceof ApiError && error.status === 403 ? 'Your role cannot open the Raast QR set-up' : 'Could not load the Raast QR set-up'}>
          <p>{connectorErrorText(error)}</p>
        </Banner>
      )}

      {data && (
        <>
          {!data.secretKeyConfigured && (
            <Banner tone="bad" title="SERVD_SECRET_KEY is not set on the server">
              <p>Counter-phone tokens are stored encrypted with it, so no device can be added until IT sets it on the API container.</p>
            </Banner>
          )}
          {section === 'overview' && <RaastOverviewSection data={data} companyName={companyName} canEdit={canEdit} isCeo={isCeo} onGo={go} />}
          {section === 'devices' && <RaastDevices data={data} canEdit={canEdit} isCeo={isCeo} activeTenantId={activeTenantId} />}
          {section === 'banks' && <RaastSendersTemplates data={data} canEdit={canEdit} />}
          {section === 'tester' && <RaastTester data={data} />}
          {section === 'log' && <RaastSmsLog data={data} />}
          {section === 'accounts' && <RaastAccounts data={data} />}
        </>
      )}
    </div>
  )
}
