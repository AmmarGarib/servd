'use client'
// "Move to another company" on a PO raised in the wrong company (owner, 2026-11-14). Shown only before the CEO's
// approval and only to someone in two or more companies. POST /procurement/purchase-orders/:id/move-company makes a
// new draft in the company picked and cancels this one.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button, Field } from '../finance/ui'
import { Select } from '../ui/Select'

interface Company { id: string; name: string; kind?: 'company' | 'head_office'; isActive?: boolean }
interface Moved { newReference: string | null; toCompany: string; supplierKept: boolean; buyerKept: boolean }

export function MovePoCompany({ poId, status, tenantId, onMoved }: { poId: string; status: string; tenantId: string | null | undefined; onMoved?: () => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [done, setDone] = useState<Moved | null>(null)
  const { data: companies = [] } = useQuery({ queryKey: ['tenants', 'mine'], queryFn: () => api.get<Company[]>('/tenants/mine'), staleTime: 300_000 })
  const others = companies.filter((c) => c.id !== tenantId && c.kind !== 'head_office' && c.isActive !== false)
  const mut = useMutation({
    mutationFn: () => api.post<Moved>(`/procurement/purchase-orders/${poId}/move-company`, { tenantId: to }),
    onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ['procurement'] }); onMoved?.() },
  })

  if (done) {
    return (
      <p role="status" className="rounded-lg border border-s-border bg-s-surface px-3 py-2 text-xs text-s-text">
        Moved to {done.toCompany} as <span className="font-semibold">{done.newReference ?? 'a new PO'}</span> (a draft — submit it there).
        {!done.supplierKept && ' Choose its supplier there.'}{!done.buyerKept && ' Pick its buyer there.'} This one is cancelled.
      </p>
    )
  }
  if (!['draft', 'pending_approval'].includes(status) || !tenantId || others.length === 0) return null
  if (!open) {
    return <Button variant="secondary" type="button" onClick={() => setOpen(true)}>Move to another company</Button>
  }
  return (
    <form noValidate className="space-y-3 rounded-lg border border-s-border bg-s-surface p-3"
      onSubmit={(e) => { e.preventDefault(); if (to && !mut.isPending) mut.mutate() }}>
      <p className="text-xs text-s-muted">Raised in the wrong company? A new draft with the same lines is made in the company you pick, and this PO is cancelled. You submit it again there.</p>
      <Field label="Move to" required>
        <Select value={to} onChange={(e) => setTo(e.target.value)} className="s-input w-full sm:w-80">
          <option value="">Choose a company…</option>
          {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      {mut.error && <p role="alert" className="text-xs text-s-red">{mut.error instanceof Error ? mut.error.message : 'That did not work'}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="submit" disabled={!to || mut.isPending}>{mut.isPending ? 'Moving…' : 'Move PO'}</Button>
        <Button variant="secondary" type="button" onClick={() => { setOpen(false); setTo(''); mut.reset() }}>Back</Button>
      </div>
    </form>
  )
}
