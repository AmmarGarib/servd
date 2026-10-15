'use client'
// Head office → Hand-over: the delegations of this head office. Grant uses the
// shared dialogs (HO-D2, components/approvals/DelegationDialogs.tsx); revoke is
// the shared revoke dialog.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DelegationGrantDialog, DelegationRevokeDialog } from '../../../../components/approvals/DelegationDialogs'
import { headOfficeApi, type DelegationRow } from '../../../../lib/headOfficeApi'

const STATE_BADGE: Record<DelegationRow['state'], string> = { live: 's-badge-green', not_started: 's-badge-purple', expired: 's-badge-muted', revoked: 's-badge-muted' }

export default function HandOverTab({ hoId }: { hoId: string }) {
  const q = useQuery({ queryKey: ['ho-delegations'], queryFn: headOfficeApi.delegations })
  const [granting, setGranting] = useState(false)
  const [revoking, setRevoking] = useState<DelegationRow | null>(null)
  const rows = (q.data?.delegations ?? []).filter((d) => d.tenantId === hoId)
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-white/60">Approvals you have handed to people of this head office.</p>
        <button type="button" className="s-btn-primary text-xs" onClick={() => setGranting(true)}>Hand over approvals</button>
      </div>
      <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <table className="s-table">
          <thead><tr><th>Person</th><th>Section</th><th>Scope</th><th>Until</th><th>State</th><th /></tr></thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={6} className="text-white/45">Loading…</td></tr>}
            {!q.isLoading && rows.length === 0 && <tr><td colSpan={6} className="text-white/45">Nothing is handed over.</td></tr>}
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="font-semibold">{d.delegateName ?? '—'}</td>
                <td>{d.sectionTitle}</td>
                <td>{d.scopeName}</td>
                <td>{d.endsAt ? new Date(d.endsAt).toLocaleDateString('en-GB') : 'No end date'}</td>
                <td><span className={STATE_BADGE[d.state]}>{d.state.replace('_', ' ')}</span></td>
                <td className="text-right">{(d.state === 'live' || d.state === 'not_started') && <button type="button" className="s-btn-secondary text-xs" onClick={() => setRevoking(d)}>End</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {granting && <DelegationGrantDialog headOfficeId={hoId} onClose={() => setGranting(false)} onDone={() => { setGranting(false); void q.refetch() }} />}
      {revoking && <DelegationRevokeDialog delegationId={revoking.id} label={`${revoking.sectionTitle} to ${revoking.delegateName ?? 'a login'}`} headOfficeId={hoId} onClose={() => setRevoking(null)} onDone={() => { setRevoking(null); void q.refetch() }} />}
    </div>
  )
}
