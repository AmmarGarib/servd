'use client'
// Finance → Wallet top-ups (owner, 2026-10-16: finance records paid wallet
// top-ups). A customer paid us to load their wallet: a back-office receipt
// like a gift-card sale — cash, bank transfer, bank deposit or cheque (never
// card), always with its payment reference #, through the shared
// <PaymentReceivedFields>. The top-up is credited and booked in the ACTIVE
// company (Dr the money account / Cr 2050 Wallet Liability) and spendable only
// at that company's brands. A goodwill credit (our cost) is a manager's call
// and lives on Customers / CRM, not here (the API answers 403
// GOODWILL_MANAGERS_ONLY to finance).
//
// API: GET /wallet/customers?q= (customers of the active company), POST
// /wallet/topup {kind: 'paid', tender, paymentRef, bankAccountId?}.

import { Button, FieldLabel, Input } from '@/components/finance/ui'
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { useActiveCompany } from '../../../lib/connectorsApi'
import {
  PaymentReceivedFields, ReferenceUsedBeforeNotice, receiptFieldsValid, receiptMethodLabel,
  isBankMethod, PAYMENT_REFERENCE_ERROR_TEXT, type PaymentRefUse,
} from '../../../components/finance/PaymentReceivedFields'

interface FoundCustomer { id: string; name: string; phone: string | null; email: string | null; walletBalanceCents: number }

const ERROR_TEXT: Record<string, string> = {
  ...PAYMENT_REFERENCE_ERROR_TEXT,
  GOODWILL_MANAGERS_ONLY: 'A goodwill credit is a manager\'s call — record paid top-ups here.',
  BANK_ACCOUNT_REQUIRED: 'This company has more than one bank — pick the bank account the money went into.',
}
const errText = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return (x?.code && ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

const panel = { background: 'var(--surface)', border: '1px solid var(--border)' }
const fieldCls = 's-input w-full'

export default function WalletTopupsPage() {
  const qc = useQueryClient()
  const company = useActiveCompany()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<FoundCustomer | null>(null)
  const [amountCents, setAmountCents] = useState(0)
  const [method, setMethod] = useState('bank_transfer')
  const [reference, setReference] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [done, setDone] = useState<{ name: string; amountCents: number; newBalance: number; uses: PaymentRefUse[] } | null>(null)

  const term = q.trim()
  const { data: found, isFetching, error: findError } = useQuery({
    queryKey: ['wallet-customers', company?.id, term],
    queryFn: () => api.get<{ customers: FoundCustomer[] }>(`/wallet/customers?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 3,
  })

  const topup = useMutation({
    mutationFn: () => api.post<{ newBalance: number; referenceUsedBefore?: PaymentRefUse[] }>('/wallet/topup', {
      customerId: picked!.id,
      amountCents,
      kind: 'paid',
      tender: method,
      paymentRef: reference.trim(),
      description: `Paid top-up (${receiptMethodLabel(method).toLowerCase()})`,
      ...(isBankMethod(method) && bankAccountId ? { bankAccountId } : {}),
    }, company ? { tenantId: company.id } : undefined),
    onSuccess: (r) => {
      setDone({ name: picked!.name, amountCents, newBalance: r.newBalance, uses: r.referenceUsedBefore ?? [] })
      setPicked(null); setAmountCents(0); setReference(''); setBankAccountId('')
      void qc.invalidateQueries({ queryKey: ['wallet-customers'] })
    },
  })

  const ready = !!picked && amountCents > 0 && receiptFieldsValid({ method, reference }) && !topup.isPending

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="border-b px-4 py-6 sm:px-7" style={{ borderColor: 'var(--border)' }}>
        <Link href="/accounting" className="text-xs text-s-muted hover:text-white/70">← Accounting</Link>
        <h1 className="mt-2 text-2xl font-black text-white/90">Wallet top-ups</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          A customer paid to load their wallet. Recorded and booked in {company?.name ?? 'the active company'} (Wallet Liability 2050),
          spendable only at its brands. Cash, bank transfer, bank deposit or cheque, with the payment reference #.
        </p>
      </header>

      <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-7">
        {done && (
          <div role="status" className="space-y-2 rounded-2xl p-4 text-sm" style={panel}>
            <p className="text-success font-semibold">
              {fmtPkr(done.amountCents)} credited to {done.name}. Wallet balance now {fmtPkr(done.newBalance)}.
            </p>
            <ReferenceUsedBeforeNotice uses={done.uses} />
          </div>
        )}

        <section className="space-y-3 rounded-2xl p-4" style={panel}>
          <FieldLabel htmlFor="wt-search" className="block">Customer</FieldLabel>
          {picked ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <p className="font-semibold text-white/90">{picked.name}</p>
                <p className="text-white/45">{[picked.phone, picked.email].filter(Boolean).join(' · ')} · wallet {fmtPkr(picked.walletBalanceCents)}</p>
              </div>
              <Button size="sm" variant="ghost" type="button" onClick={() => setPicked(null)}>Change</Button>
            </div>
          ) : (
            <>
              <Input id="wt-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
                placeholder="Name, phone or email (3+ characters)" className={fieldCls} />
              {findError && <p role="alert" className="text-xs text-s-red">{errText(findError)}</p>}
              {term.length >= 3 && !isFetching && (found?.customers.length ?? 0) === 0 && (
                <p className="text-xs text-s-muted">No customer of this company matches. A customer belongs to a company once they order or book at one of its brands.</p>
              )}
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {found?.customers.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => { setPicked(c); setDone(null) }}
                      className="w-full px-1 py-2 text-left text-sm hover:bg-white/[0.04]">
                      <span className="font-semibold text-white/85">{c.name}</span>
                      <span className="text-white/45"> · {[c.phone, c.email].filter(Boolean).join(' · ')} · wallet {fmtPkr(c.walletBalanceCents)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {picked && (
          <form className="space-y-3 rounded-2xl p-4" style={panel}
            onSubmit={(e) => { e.preventDefault(); if (ready) topup.mutate() }}>
            <div>
              <FieldLabel htmlFor="wt-amount" className="block">Amount received (PKR)</FieldLabel>
              <MoneyInput id="wt-amount" value={amountCents} onChange={setAmountCents} className={fieldCls} />
            </div>
            <PaymentReceivedFields
              tenantId={company?.id}
              method={method} onMethod={setMethod}
              reference={reference} onReference={setReference}
              bankAccountId={bankAccountId} onBank={setBankAccountId}
              idPrefix="wt"
            />
            {topup.isError && <p role="alert" className="text-xs text-s-red">{errText(topup.error)}</p>}
            <Button type="submit" disabled={!ready}>
              {topup.isPending ? 'Recording…' : 'Record paid top-up'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
