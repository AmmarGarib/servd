'use client'
// Suppliers are servd's (owner, 2026-11-14): every supplier picker lists the company's own accounts first, then the
// rest of the servd list. Picking one of those opens the company's account with that supplier
// (POST /procurement/suppliers/from-master) and hands its id back — so each form keeps working with a normal
// supplier id of its own company. Money never crosses companies: an account opened here starts at zero.
//
//   const servd = useServdSupplierPick({ tenantId, ownIds, onOpened: (s) => { setSupplierId(s.id); refetchOwn() } })
//   <Select value={supplierId} onChange={(e) => { if (!servd.pick(e.target.value)) setSupplierId(e.target.value) }}>
//     …own options…{servd.options}
//   </Select>
//   {servd.note}
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface MasterRow { id: string; name: string; companySupplierId: string | null }
export interface OpenedSupplier { id: string; name: string; [k: string]: unknown }

const PREFIX = 'master:'

export function useServdSupplierPick({ tenantId, ownIds, onOpened, enabled = true }: {
  /** The company the picker is for; none = the company picked at the top. */
  tenantId?: string | null
  /** Ids already listed by the form (the company's own accounts). */
  ownIds: string[]
  onOpened: (supplier: OpenedSupplier) => void
  enabled?: boolean
}): { options: ReactNode; pick: (value: string) => boolean; note: ReactNode; pending: boolean } {
  const qc = useQueryClient()
  const [opened, setOpened] = useState<OpenedSupplier[]>([])
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''
  const { data: masters = [] } = useQuery({
    queryKey: ['procurement', 'supplier-masters', tenantId ?? 'active'],
    queryFn: () => api.get<MasterRow[]>(`/procurement/supplier-masters${qs}`),
    enabled, staleTime: 60_000, retry: false, meta: { background: true },
  })
  const open = useMutation({
    mutationFn: (masterSupplierId: string) =>
      api.post<OpenedSupplier>('/procurement/suppliers/from-master', { masterSupplierId, ...(tenantId ? { tenantId } : {}) }),
    onSuccess: (s) => {
      setOpened((cur) => (cur.some((x) => x.id === s.id) ? cur : [...cur, s]))
      void qc.invalidateQueries({ queryKey: ['procurement', 'supplier-masters'] })
      void qc.invalidateQueries({ queryKey: ['procurement', 'suppliers'] })
      onOpened(s)
    },
  })
  const own = new Set(ownIds)
  const justOpened = opened.filter((s) => !own.has(s.id))
  const others = masters.filter((m) => !m.companySupplierId || (!own.has(m.companySupplierId) && !justOpened.some((s) => s.id === m.companySupplierId)))

  const options = (
    <>
      {justOpened.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      {others.length > 0 && (
        <optgroup label="Other servd suppliers">
          {others.map((m) => <option key={m.id} value={m.companySupplierId ?? PREFIX + m.id}>{m.name}</option>)}
        </optgroup>
      )}
    </>
  )
  const pick = (value: string) => {
    if (!value.startsWith(PREFIX)) return false
    if (!open.isPending) open.mutate(value.slice(PREFIX.length))
    return true
  }
  const note = open.isPending
    ? <p className="mt-1 text-xs text-s-muted">Opening this company&apos;s account with the supplier…</p>
    : open.error
      ? <p role="alert" className="mt-1 text-xs text-s-red">{open.error instanceof Error ? open.error.message : 'Could not add that supplier'}</p>
      : null
  return { options, pick, note, pending: open.isPending }
}
