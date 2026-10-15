'use client'
// Hand-over — what the CEO has handed to head-office people, and what ended.
// Granting and revoking go through the dialogs; the API decides (CEO only).

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { DelegationGrantDialog, DelegationRevokeDialog } from '../../../../components/approvals/DelegationDialogs'
import { useAuthStore } from '../../../../store/auth'
import { APPROVALS_CATALOG_KEY, APPROVALS_DELEGATIONS_KEY, type CatalogSection, type Delegation } from '../../approvalsData'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

export default function HandOverPage() {
  // Every login can open this page (/ceo/approvals is personal); only the CEO
  // grants and takes back. A delegate sees what was handed to them.
  const isCeo = useAuthStore((st) => st.isRole('admin'))
  const [granting, setGranting] = useState(false)
  const [revoking, setRevoking] = useState<Delegation | null>(null)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: APPROVALS_DELEGATIONS_KEY,
    queryFn: async () => (await api.get<{ delegations: Delegation[] }>('/approvals/delegations')).delegations,
  })
  const { data: catalog } = useQuery({
    queryKey: APPROVALS_CATALOG_KEY,
    queryFn: async () => (await api.get<{ sections: CatalogSection[] }>('/approvals/catalog')).sections,
  })
  const typeLabels = new Map<string, string>()
  for (const s of catalog ?? []) for (const t of s.types) typeLabels.set(t.type, t.label)
  const labelOf = (t: string) => typeLabels.get(t) ?? t.replace(/_/g, ' ')
  const all = data ?? []
  const active = all.filter((d) => d.state === 'live' || d.state === 'not_started')
  const ended = all.filter((d) => d.state === 'expired')
  const revoked = all.filter((d) => d.state === 'revoked')

  return (
    <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
      <Link href="/ceo/approvals" className="text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>Back to approvals</Link>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-success">{isCeo ? 'CEO' : 'Approvals'}</p>
          <h1 className="text-2xl sm:text-3xl font-black text-white/90">{isCeo ? 'Hand over approvals' : 'Handed to you'}</h1>
        </div>
        {isCeo && <button onClick={() => setGranting(true)} className="ml-auto rounded-lg px-3 py-2 text-xs font-black"
          style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>Hand over a section</button>}
      </div>
      <p className="text-sm text-white/50 mt-1 max-w-3xl">
        {isCeo
          ? <>A head-office person can decide a section&rsquo;s approvals for you. You can still decide every item yourself,
            and you can take a hand-over back at any time.</>
          : <>The approval sections the CEO has handed to you. Their items appear in your approvals inbox while the hand-over is active.</>}
      </p>

      {isLoading && <p className="mt-5 text-sm text-white/40">Loading…</p>}
      {error && <p className="mt-5 text-sm" style={{ color: 'var(--erp-danger)' }}>Could not load hand-overs: {(error as Error).message}</p>}

      {!isLoading && !error && (
        <div className="mt-5 space-y-6">
          <Group title="Active" rows={active} labelOf={labelOf} empty={isCeo ? 'Nothing is handed over.' : 'Nothing is handed to you.'}
            onRevoke={isCeo ? setRevoking : undefined} />
          {ended.length > 0 && <Group title="Ended" rows={ended} labelOf={labelOf} />}
          {revoked.length > 0 && <Group title="Taken back" rows={revoked} labelOf={labelOf} />}
        </div>
      )}

      {isCeo && granting && <DelegationGrantDialog onDone={() => { setGranting(false); void refetch() }} onClose={() => setGranting(false)} />}
      {isCeo && revoking && (
        <DelegationRevokeDialog delegationId={revoking.id} label={`${revoking.sectionTitle} from ${revoking.delegateName ?? 'them'}`}
          onDone={() => { setRevoking(null); void refetch() }} onClose={() => setRevoking(null)} />
      )}
    </div>
  )
}

function Group({ title, rows, labelOf, empty, onRevoke }: {
  title: string; rows: Delegation[]; labelOf: (type: string) => string; empty?: string; onRevoke?: (d: Delegation) => void
}) {
  return (
    <section>
      <h2 className="text-sm font-black text-white/80">{title} <span className="text-white/40 font-bold">{rows.length}</span></h2>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && empty && <p className="text-xs text-white/45">{empty}</p>}
        {rows.map((d) => (
          <div key={d.id} className="rounded-2xl p-4" style={card}>
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <p className="text-[15px] font-black text-white/90 break-words">{d.sectionTitle} to {d.delegateName ?? 'unknown'}</p>
              {d.state === 'not_started' && <span className="text-[10px] font-bold text-white/50">Not started</span>}
              {onRevoke && (
                <button onClick={() => onRevoke(d)} className="ml-auto rounded-lg px-3 py-1.5 text-xs font-black"
                  style={{ border: '1px solid var(--erp-danger)', color: 'var(--erp-danger)' }}>Take back</button>
              )}
            </div>
            <p className="text-xs text-white/55">{d.scopeName}</p>
            <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1 text-xs">
              <Fact k="Types" v={d.approvalTypes.length ? d.approvalTypes.map(labelOf).join(', ') : 'Every type in the section'} />
              <Fact k="From" v={fmt(d.startsAt)} />
              <Fact k="Until" v={fmt(d.endsAt) ?? 'No end date'} />
              <Fact k="Handed over by" v={d.grantedByName} />
              {d.note && <Fact k="Note" v={d.note} />}
              {d.revokedAt && <Fact k="Taken back" v={`${fmt(d.revokedAt)}${d.revokedByName ? ` by ${d.revokedByName}` : ''}`} />}
              {d.revokeReason && <Fact k="Reason" v={d.revokeReason} />}
            </dl>
          </div>
        ))}
      </div>
    </section>
  )
}

function Fact({ k, v }: { k: string; v: string | null }) {
  if (!v) return null
  return (
    <div className="flex gap-2 min-w-0">
      <dt className="text-white/40 shrink-0">{k}</dt>
      <dd className="text-white/75 font-semibold truncate" title={v}>{v}</dd>
    </div>
  )
}
