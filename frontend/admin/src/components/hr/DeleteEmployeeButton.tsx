'use client'
// Delete an employee — HR asks, the CEO approves (owner, 2026-11-05: "Give
// option to HR to delete employee from list with CEO's approval"). Used on the
// HR employee profile and on the Employees list rows. The server decides
// (hr/employeeDelete.ts): only an entry with no payroll / books history and no
// linked login can be deleted (409 EMPLOYEE_HAS_HISTORY / EMPLOYEE_HAS_LOGIN —
// the message is shown as it comes). HR's request answers 202 and the employee
// stays until the CEO approves (approvals inbox, type employee_delete); the
// CEO's own delete is immediate and the employee goes to the Trash. A pending
// request shows here with Withdraw (GET /hr/employee-delete-requests — one
// shared query for every row on the page, never one request per row).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { useAuthStore } from '../../store/auth'
import { useConfirm } from '@/components/ui/ConfirmDialog'

const DELETE_PENDING_KEY = ['employee-delete-requests', 'pending'] as const
interface PendingDelete { id: string; employeeId: string; requestedById: string; createdAt: string }

const ghost = 'rounded-md px-2 py-1.5 text-[11px] font-bold border border-s-border text-s-muted hover:text-s-red hover:border-s-red/40 disabled:opacity-50 [@media(pointer:coarse)]:min-h-[44px]'
const dateOf = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** HR and the CEO only (the server refuses everyone else too). */
export function useCanDeleteEmployees(): boolean {
  const { data: me } = usePermissions()
  return me?.role === 'hr' || me?.role === 'admin'
}

export function DeleteEmployeeButton({ employee, onDeleted, compact = false }: {
  employee: { id: string; fullName: string; employeeCode: string }
  /** Called after the CEO's delete (the employee is gone). */
  onDeleted?: () => void
  /** A list row: shorter labels. */
  compact?: boolean
}) {
  const { data: me } = usePermissions()
  const myId = useAuthStore((st) => st.user?.id ?? '')
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const role = me?.role
  const can = role === 'hr' || role === 'admin'
  const isCeo = role === 'admin'
  // Every button on the page shares this one query (same key).
  const pendingQ = useQuery({
    queryKey: DELETE_PENDING_KEY,
    queryFn: () => api.get<{ items: PendingDelete[] }>('/hr/employee-delete-requests?status=pending'),
    enabled: can,
    staleTime: 30_000,
  })
  const pending = pendingQ.data?.items?.find((r) => r.employeeId === employee.id) ?? null
  const del = useMutation({
    mutationFn: (reason: string) => api.post<{ pendingApproval?: boolean; deleted?: boolean }>(`/hr/employees/${employee.id}/delete-request`, { reason }),
    onSuccess: (r) => {
      setErr('')
      void qc.invalidateQueries({ queryKey: DELETE_PENDING_KEY })
      if (r?.deleted) {
        void qc.invalidateQueries({ queryKey: ['hr-employees'] })
        onDeleted?.()
      } else {
        setMsg('Sent to the CEO. The employee stays until the CEO approves.')
      }
    },
    onError: (e: Error) => { setMsg(''); setErr(e.message) },
  })
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/hr/employee-delete-requests/${id}/withdraw`, {}),
    onSuccess: () => { setErr(''); setMsg('Delete request withdrawn.'); void qc.invalidateQueries({ queryKey: DELETE_PENDING_KEY }) },
    onError: (e: Error) => { setMsg(''); setErr(e.message) },
  })
  if (!can) return null

  const ask = async () => {
    const r = await confirm(isCeo ? {
      title: `Delete ${employee.fullName} (${employee.employeeCode})?`,
      body: 'Only for a wrong or duplicate entry with no payslips, pay records or login. The employee and their documents go to the Trash, where you can restore them.',
      confirmLabel: 'Delete employee', danger: true, reason: { label: 'Reason (at least 10 characters)', minLength: 10 },
    } : {
      title: `Request deletion of ${employee.fullName} (${employee.employeeCode})?`,
      body: 'Only for a wrong or duplicate entry with no payslips, pay records or login. The CEO approves it; until then the employee stays as they are.',
      confirmLabel: 'Send to the CEO', danger: true, reason: { label: 'Reason (at least 10 characters)', minLength: 10 },
    })
    if (r && r.reason) del.mutate(r.reason)
  }

  return (
    <div className={compact ? 'flex flex-col items-end gap-1' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        {pending ? (
          <>
            <span className="text-[11px] font-bold text-s-muted">
              {compact ? 'Deletion waiting for the CEO' : `Deletion waiting for the CEO — requested ${dateOf(pending.createdAt)}`}
            </span>
            {(isCeo || pending.requestedById === myId) && (
              <button type="button" className={ghost} disabled={withdraw.isPending} onClick={async () => {
                const r = await confirm({ title: `Withdraw the delete request for ${employee.fullName}?`, body: 'The employee stays and the CEO no longer sees the request.', confirmLabel: 'Withdraw' })
                if (r) withdraw.mutate(pending.id)
              }}>{withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}</button>
            )}
            {isCeo && (
              <button type="button" className={ghost} disabled={del.isPending} onClick={() => void ask()}>{del.isPending ? 'Deleting…' : 'Delete employee'}</button>
            )}
          </>
        ) : (
          <button type="button" className={ghost} disabled={del.isPending} onClick={() => void ask()}>
            {del.isPending ? (isCeo ? 'Deleting…' : 'Sending…') : isCeo ? (compact ? 'Delete' : 'Delete employee') : compact ? 'Request deletion' : 'Request deletion (CEO approves)'}
          </button>
        )}
      </div>
      {err && <p className={`text-xs text-s-red mt-2 ${compact ? 'max-w-[18rem] text-right whitespace-normal' : 'max-w-xl'}`} role="alert">{err}</p>}
      {msg && <p className={`text-xs text-white/60 mt-2 ${compact ? 'max-w-[18rem] text-right whitespace-normal' : ''}`} role="status">{msg}</p>}
    </div>
  )
}
