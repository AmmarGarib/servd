'use client'
// "Your purchase orders" on a person's home (owner, 2026-11-09: "add to home page" — a buyer should see a PO to buy
// the moment they log in, not only on the Procurement page). Reads the ONE task list (GET /procurement/my-tasks, the
// same as Procurement → My tasks): to buy, to confirm (what arrived), to fix (a GRN sent back). Shown only when there
// is something; every row opens it on Procurement → My tasks. A login that cannot open procurement gets nothing (no
// toast — a background read).
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { MY_TASKS_KEY, type MyTasks } from './PoWorkflow'

const pkr = (cents: number) => `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`

export function MyPoTasksCard() {
  const { data } = useQuery({
    queryKey: MY_TASKS_KEY,
    queryFn: () => api.get<MyTasks>('/procurement/my-tasks'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    meta: { background: true },
    retry: (count, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && count < 1,
  })
  if (!data) return null
  const rows = [
    ...data.toBuy.map((po) => ({ key: `b:${po.id}`, label: 'To buy', ref: po.reference ?? po.id.slice(-8).toUpperCase(), who: po.supplier?.name ?? '—', total: po.totalCents })),
    ...data.toConfirm.map((po) => ({ key: `c:${po.id}`, label: 'Confirm what arrived', ref: po.reference ?? po.id.slice(-8).toUpperCase(), who: po.supplier?.name ?? '—', total: po.totalCents })),
    ...data.toFix.map((g) => ({ key: `f:${g.id}`, label: 'Fix the invoice', ref: g.po.reference ?? g.grnNumber, who: g.po.supplier?.name ?? '—', total: g.po.totalCents })),
  ]
  if (rows.length === 0) return null
  return (
    <section className="mt-5 rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.55)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-black text-white/90">Your purchase orders <span className="ml-1 s-badge-green">{rows.length}</span></h2>
        <Link href="/procurement?tab=tasks" className="text-xs font-bold text-primary-ink hover:underline whitespace-nowrap">Open →</Link>
      </div>
      <ul className="mt-2 divide-y divide-white/[0.06]">
        {rows.slice(0, 6).map((r) => (
          <li key={r.key}>
            {/* The step on its own line, so the PO and supplier get the full width on a phone. */}
            <Link href="/procurement?tab=tasks" className="block py-2 hover:opacity-90 min-w-0">
              <span className="block text-[10px] font-black uppercase tracking-wider text-success">{r.label}</span>
              <span className="mt-0.5 flex items-baseline gap-3 min-w-0">
                <span className="min-w-0 flex-1 truncate text-sm text-white/85"><span className="font-bold">{r.ref}</span> · {r.who}</span>
                <span className="shrink-0 font-mono text-xs text-white/60">{pkr(r.total)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > 6 && <p className="mt-1 text-xs text-white/45">and {rows.length - 6} more on Procurement → My tasks</p>}
    </section>
  )
}
