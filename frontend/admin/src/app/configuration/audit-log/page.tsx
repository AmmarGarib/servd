'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import Link from 'next/link'

// The IDENTITY trail: who exists, what access they hold, and what they did on
// shift.
//
// This page was a stub. It rendered a hardcoded table asserting that failed
// logins were kept for 90 days and records retained for 7 years — neither of
// which was implemented — and it never called the API at all. Meanwhile the
// only working viewer lived under /accounting and showed the ledger's trail to
// every finance-tier role in both companies.
//
// The two are now separate feeds from separate endpoints. This one is readable
// by managers, because they need it to run a shift. The books' trail is not.
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

// Grouped by the question being asked, not by the verb. "Who got access" is one
// question; "what happened on the floor" is another, and mixing them is what
// made the old single log unreadable.
const ACTION_FILTERS = [
  { key: '',              label: 'Everything' },
  { key: 'user.',         label: 'Accounts & roles' },
  { key: 'role_modules',  label: 'Permissions' },
  { key: 'order_',        label: 'Refunds, voids, comps' },
  { key: 'giftcard',      label: 'Gift cards' },
  { key: 'stock-transfer', label: 'Stock moves' },
] as const

// The handful of actions worth calling out in colour — the ones that change who
// can do what, rather than what was done.
const ACCESS_ACTIONS = new Set([
  'user.create', 'user.role_change', 'user.enable', 'user.disable',
  'user.password_reissue', 'user.pin_reissue', 'role_modules.update',
])

export default function IdentityAuditLogPage() {
  const [action, setAction] = useState('')
  const [openRow, setOpenRow] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['identity-audit-log', action],
    queryFn: () => api.get<{ data: AuditRow[] }>(
      `/auth/audit-log?limit=200${action ? `&action=${action}` : ''}`,
    ),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/configuration" className="text-xs text-s-muted hover:text-s-text">← Configuration</Link>
        <h1 className="text-xl font-bold text-s-text">Audit log</h1>
        <p className="text-xs text-s-muted mt-1">
          Accounts, roles and permissions, plus what staff did on shift. Append-only.
          The books&rsquo; own trail — period closes, journals, wage rates — lives in
          Accounting and is restricted.
        </p>
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-3">
        <div className="flex gap-2 flex-wrap">
          {ACTION_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setAction(f.key)}
              aria-pressed={action === f.key}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                action === f.key ? 'bg-black text-white border-black' : 'bg-white border-s-border text-s-text hover:bg-s-bg-soft'
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
                  <th className="px-4 py-2 text-left">Who it touched</th>
                  <th className="px-4 py-2 text-left">By</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-s-muted">Loading…</td></tr>
                )}
                {error != null && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-s-muted">
                    Could not load the audit log.
                  </td></tr>
                )}
                {(data?.data ?? []).map((r) => {
                  const open = openRow === r.id
                  return <Row key={r.id} row={r} open={open} onToggle={() => setOpenRow(open ? null : r.id)} />
                })}
                {data?.data.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-s-muted">No entries match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[11px] text-s-muted">
          Entries recorded before the trail was split carry no company and are visible
          to the CEO only — the person who acted may belong to more than one company,
          so they cannot be attributed after the fact.
        </p>
      </div>
    </div>
  )
}

function Row({ row, open, onToggle }: { row: AuditRow; open: boolean; onToggle: () => void }) {
  const date = new Date(row.createdAt)
  const isAccess = ACCESS_ACTIONS.has(row.action)
  // A role change is the one entry you want to read without opening it.
  const before = row.before as { role?: string } | null
  const after = row.after as { role?: string; targetEmail?: string } | null
  const roleMove = row.action === 'user.role_change' && before?.role && after?.role
    ? `${before.role} → ${after.role}`
    : null

  return (
    <>
      <tr className="border-t border-s-border hover:bg-s-bg-soft cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2 text-xs text-s-muted">{date.toLocaleString()}</td>
        <td className="px-4 py-2 font-mono text-xs">
          <span className={`rounded px-1.5 py-0.5 border ${
            isAccess
              ? 'bg-amber-50 border-amber-300 text-amber-900'
              : 'bg-s-bg-soft border-s-border text-s-text'
          }`}>
            {row.action}
          </span>
        </td>
        <td className="px-4 py-2 text-xs">
          <span className="text-s-text">{after?.targetEmail ?? row.entity}</span>
          {roleMove && <span className="ml-2 font-mono text-[11px] text-amber-800">{roleMove}</span>}
          {!roleMove && row.entityId && <span className="text-s-muted ml-1">#{row.entityId.slice(0, 8)}</span>}
        </td>
        <td className="px-4 py-2 text-xs text-s-text">
          {row.userEmail ?? <span className="text-s-muted">system</span>}
        </td>
        <td className="px-4 py-2 text-right"><span className="text-xs text-s-muted">{open ? '▾' : '▸'}</span></td>
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
