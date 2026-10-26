'use client'
// Correct a guest's phone or email (owner C20, 2026-10-26) — managers only.
// POST /crm/customers/:id/contact { phone?, email?, reason ≥10 }. The server
// signs the guest out everywhere, clears the changed contact's verification,
// refuses a contact another guest holds, sends nothing, and audits it.

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Modal } from '@/components/ui/Modal'

const inp = 'rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none w-full'

export function CorrectContactModal({ customer, onClose }: {
  customer: { id: string; name: string; phone?: string | null; email?: string | null }
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [phone, setPhone] = useState(customer.phone ?? '')
  const [email, setEmail] = useState(customer.email ?? '')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const phoneChanged = phone.trim() !== '' && phone.trim() !== (customer.phone ?? '')
  const emailChanged = email.trim() !== '' && email.trim().toLowerCase() !== (customer.email ?? '').toLowerCase()

  const save = useMutation({
    mutationFn: () => api.post(`/crm/customers/${customer.id}/contact`, {
      ...(phoneChanged ? { phone: phone.trim() } : {}),
      ...(emailChanged ? { email: email.trim() } : {}),
      reason: reason.trim(),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] })
      void qc.invalidateQueries({ queryKey: ['customer-detail', customer.id] })
      onClose()
    },
    onError: (e: Error) => setErr(e.message),
  })
  const ok = (phoneChanged || emailChanged) && reason.trim().length >= 10

  return (
    <Modal title="Correct phone / email" dirty={phoneChanged || emailChanged || reason.trim() !== ''} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); if (ok && !save.isPending) save.mutate() }}>
        <p className="text-sm text-s-muted">{customer.name}</p>
        <p className="text-xs text-s-muted">
          The phone is how the guest signs in. Saving signs them out everywhere and they confirm the new contact themselves
          next time. Nothing is sent to the old or the new number or address.
        </p>
        <label className="block text-xs font-bold text-s-muted">Phone
          <input className={`${inp} mt-1`} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" name="guest-phone" />
        </label>
        <label className="block text-xs font-bold text-s-muted">Email
          <input className={`${inp} mt-1`} value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" name="guest-email" />
        </label>
        <label className="block text-xs font-bold text-s-muted">Reason (at least 10 characters)
          <input className={`${inp} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" name="contact-reason" />
        </label>
        {err && <p role="alert" className="text-xs text-s-red">{err}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={!ok || save.isPending}
            className="flex-1 rounded-xl bg-primary text-primary-on text-sm font-bold py-2 hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose}
            className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-border-strong">
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
