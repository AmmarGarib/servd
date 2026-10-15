'use client'
// Fixed-asset requests: every disposal, write-down, void, capitalisation,
// smallwares write-off and count that finance has sent. Finance raises them;
// the CEO approves or rejects (the buttons show only when the API says the
// caller may decide). The same queue feeds the CEO's approvals inbox.

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { FA_BASE, FaFrame, Notice, card, inp, errorWords, useFaLookups, type FaRequest } from '../../../../components/fixedAssets/shared'
import { RequestCard } from '../../../../components/fixedAssets/RequestCard'
import { Select } from '@/components/ui/Select'

const FILTERS: Array<{ key: string; label: string; status: string }> = [
  { key: 'pending', label: 'Waiting', status: 'pending' },
  { key: 'posted', label: 'Done', status: 'posted' },
  { key: 'rejected', label: 'Rejected', status: 'rejected' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
  { key: 'all', label: 'All', status: 'all' },
]

export default function RequestsPage() {
  const qc = useQueryClient()
  const { data: lookups } = useFaLookups()
  const [filter, setFilter] = useState('pending')
  const [kind, setKind] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'wait' | 'bad'; text: string } | null>(null)

  const qs = useMemo(() => {
    const p = new URLSearchParams()
    p.set('status', FILTERS.find((f) => f.key === filter)?.status ?? 'pending')
    if (kind) p.set('kind', kind)
    p.set('limit', '200')
    return p.toString()
  }, [filter, kind])

  const { data, isLoading, error } = useQuery<{ requests: FaRequest[]; pendingCount: number }>({
    queryKey: ['fa-requests', qs],
    queryFn: () => api.get(`${FA_BASE}/requests?${qs}`),
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['fa-requests'] })
    void qc.invalidateQueries({ queryKey: ['fa-pending-count'] })
    void qc.invalidateQueries({ queryKey: ['fa-register'] })
    void qc.invalidateQueries({ queryKey: ['fa-asset'] })
    void qc.invalidateQueries({ queryKey: ['fa-pools'] })
  }

  const isCeo = !!lookups?.capabilities.canApprove
  const list = data?.requests ?? []

  return (
    <FaFrame
      title="Requests"
      subtitle={isCeo
        ? 'What finance has asked for. Nothing here posts until you approve it.'
        : 'Disposals, write-downs and capitalisations wait here for the CEO. You can cancel your own while it waits.'}
    >
      {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}

      <div className="rounded-2xl p-4 flex flex-wrap items-end gap-3" style={card}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show requests that are">
          {FILTERS.map((f) => {
            const on = filter === f.key
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={on}
                className="rounded-full px-3 py-1.5 text-xs font-bold"
                style={on
                  ? { background: 'rgb(var(--erp-accent-rgb) / 0.2)', color: 'var(--erp-success)', border: '1px solid var(--erp-accent)' }
                  : { color: 'rgb(var(--fg-rgb) / 0.6)', border: '1px solid rgb(var(--fg-rgb) / 0.12)' }}>
                {f.label}{f.key === 'pending' && data && filter === 'pending' ? ` (${data.pendingCount})` : ''}
              </button>
            )
          })}
        </div>
        <label className="block ml-auto min-w-[200px]"><span className="text-[11px] font-bold text-white/50">Kind</span>
          <Select className={inp} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            <option value="capitalise">Capitalise from CapEx</option>
            {(lookups?.requestKinds ?? []).map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            <option value="pool_write_off">Write off smallwares units</option>
            <option value="pool_transfer">Move smallwares units</option>
            <option value="count">Smallwares count</option>
          </Select></label>
      </div>

      {error && <Notice tone="bad">{errorWords(error)}</Notice>}
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {data && list.length === 0 && (
        <div className="rounded-2xl p-10 text-center" style={card}>
          <p className="font-bold text-white/85">{filter === 'pending' ? 'Nothing is waiting' : 'No requests here'}</p>
          <p className="text-sm text-white/45 mt-1">Requests appear when finance disposes of an asset, writes one down, writes off smallwares, or prepares a CapEx item for the register.</p>
        </div>
      )}

      <div className="space-y-3">
        {list.map((r) => <RequestCard key={r.id} r={r} onChanged={refresh} onNotice={(tone, text) => setNotice({ tone, text })} />)}
      </div>
    </FaFrame>
  )
}
