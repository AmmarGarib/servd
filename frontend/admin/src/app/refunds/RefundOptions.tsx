'use client'
// How a refund goes back: only on a tender the order was actually paid with
// (F1 / ONL-16), on the card machine for a card it took (spec §7.11,
// managers), and with the evidence photo when the company's refund policy
// asks for one. Shared by /refunds and the order page, so both offer exactly
// the same choices. Admin colour tokens only.

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { useIsManager } from '../../components/pos/managerRole'
import { usePosStore } from '../../store/pos'
import type { TerminalChargeView } from '../../components/pos/tillApi'
import {
  TENDER_LABEL, fiscalRefundText, refundErrorMessage, refundOnCardMachine, refundTendersOf, refundThroughEngine,
  terminalPaymentFor, terminalRefundText, uploadEvidencePhoto,
  type RefundPayment, type RefundResult, type RefundTender,
} from './refundEngine'

export interface RefundChoice {
  /** '' = the server's default (the sale's tender) — offered only when the order took more than one tender. */
  method: RefundTender | ''
  /** Card refund through the card machine (the payment was taken on it). */
  viaMachine: boolean
  photoUrl: string | null
}

interface RefundPolicyView { requirePhotoEvidence?: boolean; requireReason?: boolean }

export function useRefundPolicy() {
  return useQuery<RefundPolicyView>({
    queryKey: ['refund-policy'],
    queryFn: () => api.get<RefundPolicyView>('/setup/refund-policy'),
    staleTime: 60_000,
    retry: false,
  })
}

/** The default choice for an order: its only tender, on the machine when the card was taken there. */
export function defaultRefundChoice(payments: RefundPayment[], source?: string | null): RefundChoice {
  const tenders = refundTendersOf(payments, source)
  const only = tenders.length === 1 ? tenders[0]! : ''
  return { method: only, viaMachine: only === 'card' && payments.some((p) => p.gateway === 'card_terminal' && p.status === 'paid'), photoUrl: null }
}

export function RefundOptions({ payments, source, amountCents, value, onChange, idPrefix = 'refund' }: {
  payments: RefundPayment[]
  /** The order's source — a completed online order may refund a card / QR row the gateway never confirmed (the server's rule). */
  source?: string | null
  amountCents: number
  value: RefundChoice
  onChange: (v: RefundChoice) => void
  idPrefix?: string
}) {
  const isManager = useIsManager()
  const policy = useRefundPolicy()
  const tenders = refundTendersOf(payments, source)
  const [uploading, setUploading] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)

  // Keep the choice valid for this order (an order switch, a tender list change).
  useEffect(() => {
    if (value.method && !tenders.includes(value.method)) onChange(defaultRefundChoice(payments, source))
    else if (!value.method && tenders.length === 1) onChange({ ...value, method: tenders[0]! })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenders.join(',')])

  const machinePayment = value.method === 'card' ? terminalPaymentFor(payments, amountCents) : null
  const machineAny = value.method === 'card' && payments.some((p) => p.gateway === 'card_terminal' && p.status === 'paid')

  // A refund on the card machine is started by a manager only (POST
  // /pos/terminal/refunds is MANAGERS): never send it for anyone else. Until
  // the manager list loads, or the user ticks / unticks it themselves, the
  // default follows the role.
  const touched = useRef(false)
  useEffect(() => {
    if (!machineAny) return
    if (!isManager && value.viaMachine) onChange({ ...value, viaMachine: false })
    else if (isManager && !touched.current && !value.viaMachine) onChange({ ...value, viaMachine: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager, machineAny])
  const needsPhoto = !!policy.data?.requirePhotoEvidence

  async function pickPhoto(file: File | undefined) {
    if (!file) return
    setPhotoError(null)
    setUploading(true)
    try {
      onChange({ ...value, photoUrl: await uploadEvidencePhoto(file) })
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'The photo upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-method`} className="text-xs font-semibold text-s-muted">Give back as</label>
        {tenders.length === 0 ? (
          <p className="text-xs text-s-amber">Nothing was paid on this order — there is nothing to refund.</p>
        ) : (
          <select id={`${idPrefix}-method`} value={value.method}
            onChange={(e) => {
              const m = e.target.value as RefundTender | ''
              onChange({ ...value, method: m, viaMachine: isManager && m === 'card' && payments.some((p) => p.gateway === 'card_terminal' && p.status === 'paid') })
            }}
            className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm text-s-text">
            {tenders.length > 1 && <option value="">Same as paid</option>}
            {tenders.map((t) => <option key={t} value={t}>{TENDER_LABEL[t]}</option>)}
          </select>
        )}
      </div>

      {machineAny && (
        isManager ? (
          <label className="flex items-start gap-2 text-xs text-s-text">
            <input type="checkbox" className="mt-0.5 accent-primary" checked={value.viaMachine}
              onChange={(e) => { touched.current = true; onChange({ ...value, viaMachine: e.target.checked }) }} />
            <span>
              Refund to the card on the card machine
              {value.viaMachine && !machinePayment && (
                <span className="block text-s-amber">No single card-machine payment covers {fmtPkr(amountCents)} — refund a smaller amount.</span>
              )}
              {!value.viaMachine && (
                <span className="block text-s-muted">Unticked: you refund on the machine by hand, servd only records it.</span>
              )}
            </span>
          </label>
        ) : (
          <p className="text-xs text-s-muted">
            This card was taken on the card machine. A refund back to the card on the machine is started by a manager;
            here servd only records a card refund you make on the machine by hand.
          </p>
        )
      )}

      {needsPhoto && (
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-photo`} className="text-xs font-semibold text-s-muted">Photo evidence (required by the refund policy)</label>
          <input id={`${idPrefix}-photo`} type="file" accept="image/*" capture="environment"
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
            className="block w-full text-xs text-s-text" />
          {uploading && <p className="text-xs text-s-muted">Uploading…</p>}
          {value.photoUrl && !uploading && <p className="text-xs text-primary-ink">Photo attached.</p>}
          {photoError && <p className="text-xs text-s-red">{photoError}</p>}
        </div>
      )}
    </div>
  )
}

/** True when the choice can be sent (a tender picked when one must be, the photo when the policy asks). */
export function refundChoiceReady(payments: RefundPayment[], choice: RefundChoice, needsPhoto: boolean, source?: string | null): boolean {
  const tenders = refundTendersOf(payments, source)
  if (tenders.length === 0) return false
  if (needsPhoto && !choice.photoUrl) return false
  return true
}

export type RefundOutcome =
  | { kind: 'engine'; result: RefundResult }
  /** `paymentId` = the card-machine payment it goes back on (to keep following an in-flight refund). */
  | { kind: 'machine'; charge: TerminalChargeView; paymentId: string }

/** Send the refund the way the choice says: the card machine, or the one refund engine. */
export async function performRefund(
  orderId: string,
  payments: RefundPayment[],
  input: { amountCents: number; reason: string; choice: RefundChoice },
  onProgress?: (c: TerminalChargeView) => void,
): Promise<RefundOutcome> {
  const { choice } = input
  if (choice.method === 'card' && choice.viaMachine) {
    const payment = terminalPaymentFor(payments, input.amountCents)
    if (!payment) throw new Error('No single card-machine payment covers this amount — refund a smaller amount, or untick the card machine.')
    const charge = await refundOnCardMachine(orderId, {
      payment,
      amountCents: input.amountCents,
      reason: input.reason,
      ...(choice.photoUrl && { photoUrl: choice.photoUrl }),
      shiftId: usePosStore.getState().shiftId,
    }, onProgress)
    return { kind: 'machine', charge, paymentId: payment.id }
  }
  const result = await refundThroughEngine(orderId, {
    amountCents: input.amountCents,
    reason: input.reason,
    ...(choice.method && { method: choice.method }),
    ...(choice.photoUrl && { photoUrl: choice.photoUrl }),
  })
  return { kind: 'engine', result }
}

/** A readable summary of a refund outcome. */
export function refundOutcomeText(o: RefundOutcome): { ok: boolean; text: string } {
  if (o.kind === 'machine') return terminalRefundText(o.charge)
  const r = o.result
  const amount = fmtPkr(Math.abs(r.amountCents))
  const base = r.orderRefunded
    ? `Refunded in full (${amount}) and booked. Credit note and customer restores issued.`
    : `Refunded ${amount} and booked. The rest of the order still stands.`
  const fiscal = fiscalRefundText(r.fiscalRefund)
  return { ok: true, text: fiscal ? `${base} ${fiscal}.` : base }
}

export { refundErrorMessage }
