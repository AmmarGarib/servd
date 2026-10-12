'use client'
// Raast QR → Receiving accounts — READ-ONLY here (spec D7, §7.5). The bank
// account a Raast transfer lands in (the company default, or a brand's own)
// is finance's decision and is set ONLY in Finance → Bank accounts; IT sees
// it so a sender can be pointed at the right account. Raast money is booked
// to that account's ledger code, never to the card clearing account.

import Link from 'next/link'
import type { RaastAccount, RaastSettingsPage } from '../../../lib/connectorsApi'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { Badge, Card } from '../ui'

const BANK_ACCOUNTS_PATH = '/configuration/bank-accounts'

function describe(a: RaastAccount | null): string {
  if (!a) return 'Not set'
  const parts = [a.accountTitle, a.bankName, a.last4 ? `…${a.last4}` : null].filter(Boolean)
  return parts.join(' · ') || 'Bank account'
}

export function RaastAccounts({ data }: { data: RaastSettingsPage }) {
  const { data: me } = usePermissions()
  const canOpen = !!me && canOpenPath(BANK_ACCOUNTS_PATH, me.role, me.modules ?? [])
  const r = data.receivingAccounts
  const brandsWithout = r.brands.filter((b) => !b.effective)

  return (
    <div className="space-y-4">
      <Card title="Where Raast money lands"
        subtitle="Set by finance in Finance → Bank accounts — read-only here. The till shows this account's title, bank and Raast ID to the customer."
        actions={canOpen ? <Link href={BANK_ACCOUNTS_PATH} className="s-btn-secondary px-2 py-1 text-xs">Open Bank accounts</Link> : undefined}>
        {!canOpen && <p className="text-xs text-s-muted">Your role cannot open Bank accounts — ask finance to change these.</p>}
        <div className="rounded-lg border border-s-border p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-s-muted">Company default</p>
          {r.default ? (
            <div className="mt-1 space-y-0.5 text-xs">
              <p className="text-sm text-s-text">{describe(r.default)}</p>
              <p className="text-s-muted">Raast ID: <span className="font-mono text-s-text">{r.default.raastId ?? 'not set'}</span> · Ledger code <span className="font-mono text-s-text">{r.default.ledgerCode}</span></p>
            </div>
          ) : (
            <p className="mt-1 text-xs text-s-amber">No company default. Brands without their own account cannot take Raast at the till.</p>
          )}
        </div>

        {r.brands.length > 0 && (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="s-table">
              <thead><tr><th>Brand</th><th>Receives into</th><th>Raast ID</th><th>Ledger code</th><th /></tr></thead>
              <tbody>
                {r.brands.map((b) => (
                  <tr key={b.conceptId}>
                    <td className="text-sm text-s-text">{b.name}</td>
                    <td className="text-xs">{describe(b.effective)}</td>
                    <td className="font-mono text-xs">{b.effective?.raastId ?? '—'}</td>
                    <td className="font-mono text-xs">{b.effective?.ledgerCode ?? '—'}</td>
                    <td>
                      {!b.effective
                        ? <Badge tone="bad">Raast not available</Badge>
                        : b.overrideBankAccountId && b.effective.bankAccountId === b.overrideBankAccountId
                          ? <Badge tone="info">Brand&rsquo;s own account</Badge>
                          : b.overrideBankAccountId
                            ? <Badge tone="warn" title="The brand's own account is inactive, deleted or not linked to the chart, so the company default is used">Own account unusable — default used</Badge>
                            : <Badge tone="muted">Company default</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {brandsWithout.length > 0 && (
          <p className="text-xs text-s-amber">
            {brandsWithout.map((b) => b.name).join(', ')} {brandsWithout.length === 1 ? 'has' : 'have'} no usable receiving account, so the till says Raast is not set up there.
          </p>
        )}
      </Card>

      <Card title="Bank accounts a sender can report on" subtitle="The company's active accounts linked to the chart of accounts. Point each bank sender at the account its SMS are about.">
        {r.bankAccounts.length === 0 ? (
          <p className="text-xs text-s-muted">None yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="s-table">
              <thead><tr><th>Account</th><th>Bank</th><th>Last 4</th><th>Raast ID</th><th>Ledger code</th></tr></thead>
              <tbody>
                {r.bankAccounts.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm text-s-text">{a.name}</td>
                    <td className="text-xs">{a.bankName ?? '—'}</td>
                    <td className="font-mono text-xs">{a.last4 ?? '—'}</td>
                    <td className="font-mono text-xs">{a.raastId ?? '—'}</td>
                    <td className="font-mono text-xs">{a.accountCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
