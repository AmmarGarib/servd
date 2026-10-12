'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import Link from 'next/link'

interface AuditRow {
  id: string
  action: string
  entity: string
  entityId: string | null
  userId: string | null
  userEmail: string | null
  before: unknown
  after: unknown
  metadata: unknown
  createdAt: string
}

const ACTION_FILTERS = [
  { key: '',                    label: 'All actions' },
  { key: 'period.close',        label: 'Period close' },
  { key: 'journal.manual',      label: 'Manual JE' },
  { key: 'wage.update',         label: 'Wage updates' },
  { key: 'allocation',          label: 'Allocation rules' },
] as const

export default function AuditLogPage() {
  const [action, setAction] = useState('')
  const [openRow, setOpenRow] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', action],
    queryFn: () => api.get<{ data: AuditRow[] }>(
      `/accounting/audit-log?limit=200${action ? `&action=${action}` : ''}`,
    ),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
        <h1 className="text-xl font-bold text-s-text">Audit log</h1>
        <p className="text-xs text-s-muted mt-1">High-stakes mutations, append-only. Forensic trail of who changed what when.</p>
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-3">
        <div className="flex gap-2 flex-wrap">
          {ACTION_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setAction(f.key)}
              aria-pressed={action === f.key}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                action === f.key ? 'bg-accent-dim text-s-text border-accent' : 'bg-s-surface border-s-border text-s-text hover:bg-s-bg-soft'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="s-card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-s-bg-soft text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">When</th>
                <th className="px-4 py-2 text-left">Action</th>
                <th className="px-4 py-2 text-left">Entity</th>
                <th className="px-4 py-2 text-left">By</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-s-muted">Loading…</td></tr>
              )}
              {(data?.data ?? []).map((r) => {
                const open = openRow === r.id
                return (
                  <Row key={r.id} row={r} open={open} onToggle={() => setOpenRow(open ? null : r.id)} />
                )
              })}
              {data?.data.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-s-muted">No audit entries match.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ row, open, onToggle }: { row: AuditRow; open: boolean; onToggle: () => void }) {
  const date = new Date(row.createdAt)
  return (
    <>
      <tr className="border-t border-s-border hover:bg-s-bg-soft cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2 text-xs text-s-muted">
          {date.toLocaleString()}
        </td>
        <td className="px-4 py-2 font-mono text-xs">
          <span className="bg-s-bg-soft border border-s-border rounded px-1.5 py-0.5 text-s-text">{row.action}</span>
        </td>
        <td className="px-4 py-2 text-xs">
          <span className="text-s-text">{row.entity}</span>
          {row.entityId && <span className="text-s-muted ml-1">#{row.entityId.slice(0, 8)}</span>}
        </td>
        <td className="px-4 py-2 text-xs text-s-text">
          {row.userEmail ?? <span className="text-s-muted">system</span>}
        </td>
        <td className="px-4 py-2 text-right">
          <span className="text-xs text-s-muted">{open ? '▾' : '▸'}</span>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-s-border bg-s-bg-soft/50">
          <td colSpan={5} className="px-6 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <p className="font-semibold text-s-muted mb-1.5">Before</p>
                <pre className="bg-s-bg-soft border border-s-border rounded p-2 overflow-x-auto text-[11px] text-s-text">
                  {row.before ? JSON.stringify(row.before, null, 2) : '(none)'}
                </pre>
              </div>
              <div>
                <p className="font-semibold text-s-muted mb-1.5">After</p>
                <pre className="bg-s-bg-soft border border-s-border rounded p-2 overflow-x-auto text-[11px] text-s-text">
                  {row.after ? JSON.stringify(row.after, null, 2) : '(none)'}
                </pre>
              </div>
              {row.metadata != null && (
                <div className="md:col-span-2">
                  <p className="font-semibold text-s-muted mb-1.5">Metadata</p>
                  <pre className="bg-s-bg-soft border border-s-border rounded p-2 overflow-x-auto text-[11px] text-s-text">
                    {JSON.stringify(row.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
