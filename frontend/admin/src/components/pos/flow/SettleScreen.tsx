'use client'
import { useEffect, useRef, useState } from 'react'
import { Delete, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../../lib/api'
import { fmtPkr, fmtPkrWhole } from '../../../lib/money'
import { orderRef } from '../../../lib/orderRef'
import { useAuthStore } from '../../../store/auth'
import { usePosStore } from '../../../store/pos'
import { useDialog } from '../../ui/Modal'
import { NumberField } from '../../ui/NumberField'
import { RaastPanel, type RaastDone } from '../RaastPanel'
import { OnAccountPanel, type OnAccountDone } from '../OnAccountPanel'
import { TerminalCharge } from '../TerminalCharge'
import {
  activeRaastIntents, activeTerminalCharges, billFor, chargeBlocks, fetchOrder, fetchReceiptHtml, fiscalLine, isPreBillRequired,
  newIdempotencyKey, paidCentsOf, printHtml, printPreBill, preBillErrorMessage, raastIntentBlocks, storedQuote, useOnAccountEnabled,
  useTerminalConfig, type FiscalView, type RaastIntentView, type TerminalChargeView, type TillBrand, type TillOrder, tableName } from '../tillApi'
import {
  checkKeenuPush, flowErrorMessage, getKeenuPush, getOrderInfo, patchOrderInfo, payServd, paySplitServd, pushToKeenu, setServdChannel,
  type KeenuAnswer, type KeenuPushView, type SplitTender,
} from './flowApi'
import { ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'

type Way = 'servd' | 'keenu'
type Tile = 'cash' | 'raast' | 'on_account' | 'card' | 'split'

interface Done {
  way: Way
  changeCents: number
  keptTipCents: number
  fiscal?: FiscalView | null
  completed: boolean
  card?: { brand: string | null; last4: string | null; approvalRef: string | null } | null
  raast?: RaastDone | null
  onAccount?: OnAccountDone | null
  keenuRef?: string | null
  at: number
}


const toCents = (s: string) => Math.round((parseFloat(s || '0') || 0) * 100)
const pkr = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, '')

// Settle (owner's flow, step 6; TILL_FLOW §6): two ways to close a bill.
//   Close in servd: Cash / Bank (Raast QR) / Credit (on account) / Card — PUT settlement-channel, then the
//                   tender's own screen / POST /pos/payments with settlementChannel "servd".
//   Push to Keenu:  POST /pos/orders/:id/keenu-push (+ /check while pending).
// Every figure is the server's (FOH-02); errors are the server's own words.
export function SettleScreen({ ticket, brand, onClose, startOnSplit }: {
  ticket: TillOrder
  brand: TillBrand | undefined
  onClose: (paid: boolean) => void
  /** Order Summary's Split: open on the Split tile. */
  startOnSplit?: boolean
}) {
  const qc = useQueryClient()
  const shiftId = usePosStore((s) => s.shiftId)
  const panelRef = useRef<HTMLDivElement>(null)
  const [order, setOrder] = useState<TillOrder>(ticket)
  const [way, setWay] = useState<Way>('servd')
  const [tile, setTile] = useState<Tile>(startOnSplit ? 'split' : 'cash')
  const [tab, setTab] = useState<'process' | 'summary'>('process')
  const [tipPkr, setTipPkr] = useState('')
  const [tipOpen, setTipOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [fresh, setFresh] = useState(true)
  const [keepAsTip, setKeepAsTip] = useState(false)
  const [printReceipt, setPrintReceipt] = useState(true)
  const [gatewayRef, setGatewayRef] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [machineDown, setMachineDown] = useState(false)
  const [chargeBlocking, setChargeBlocking] = useState(false)
  const [runningCharge, setRunningCharge] = useState<TerminalChargeView | null>(null)
  const [raastIntent, setRaastIntent] = useState<RaastIntentView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [billChanged, setBillChanged] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const [receiptMsg, setReceiptMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [printCount, setPrintCount] = useState(0)
  const [keenuMethod, setKeenuMethod] = useState<'cash' | 'card'>('cash')
  const [push, setPush] = useState<KeenuPushView | null>(null)
  const channelSet = useRef(false)
  const paySub = useRef<{ sig: string; key: string } | null>(null)

  // Cash on delivery is the server's flag (order rows and /info carry `cod`); a till delivery can be switched while nothing is paid.
  const isDelivery = order.fulfilmentType === 'delivery'
  const [codNow, setCodNow] = useState<boolean | null>(order.cod ?? null)
  const [codBusy, setCodBusy] = useState(false)
  useEffect(() => {
    if (!isDelivery || order.cod !== undefined) return
    getOrderInfo(order.id).then((v) => setCodNow(v.delivery?.cod ?? false)).catch(() => {})
  }, [isDelivery, order.id, order.cod])
  const cod = isDelivery && !!codNow
  async function switchCod(next: boolean) {
    setCodBusy(true); setError(null)
    try {
      const v = await patchOrderInfo(order.id, { delivery: { cod: next } })
      setCodNow(v.delivery?.cod ?? next)
      setOrder(await fetchOrder(order.id))
      void qc.invalidateQueries({ queryKey: ['pos'] })
    } catch (e) { setError(flowErrorMessage(e, 'Could not change how this delivery is paid')) } finally { setCodBusy(false) }
  }
  const holding = chargeBlocking || raastIntentBlocks(raastIntent)
  const tipCents = Math.max(0, toCents(tipPkr))
  const title = order.table?.label ? `${tableName(order.table.label)}` : `Order ${orderRef(order.id)}`

  // ── The server's bill for the tender in play ──────────────────────────────
  // A split follows the server's rule (lib/pricing.ts tenderOfPayments): the card (digital) rate only when EVERY
  // tender is card / Raast; any cash in the mix → the cash rate.
  const [splitRows, setSplitRows] = useState<SplitRow[]>([])
  const billTender = way === 'keenu' ? keenuMethod : tile === 'cash' || (tile === 'split' && (splitRows.length === 0 || splitRows.some((r) => r.method === 'cash'))) ? 'cash' : 'card'
  const stored = storedQuote(order)
  const bill = useQuery({
    queryKey: ['pos', 'bill', order.id, billTender, order.totalCents, stored.paidCents],
    queryFn: () => billFor(order, billTender, brand),
    enabled: !done && !cod,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const shown = tile === 'on_account' && way === 'servd' ? stored : bill.data && bill.data.kind !== 'unavailable' ? bill.data.quote : null
  const unavailable = bill.data?.kind === 'unavailable' ? bill.data.message : null
  const due = shown?.dueCents ?? 0

  // ── Resume what is already in play on this bill (a charge, a Raast request, a Keenu push) ──
  const activeCharge = useQuery({ queryKey: ['pos', 'active-charge', order.id], queryFn: () => activeTerminalCharges(order.id), staleTime: Infinity, gcTime: 0, refetchOnMount: 'always', retry: false, meta: { inlineErrors: true } })
  const activeRaast = useQuery({ queryKey: ['pos', 'active-raast', order.id], queryFn: () => activeRaastIntents(order.id), staleTime: Infinity, gcTime: 0, refetchOnMount: 'always', retry: false, meta: { inlineErrors: true } })
  const keenuNow = useQuery({ queryKey: ['pos', 'keenu-push', order.id], queryFn: () => getKeenuPush(order.id), staleTime: Infinity, gcTime: 0, refetchOnMount: 'always', retry: false, meta: { inlineErrors: true } })
  const resumeSettled = (activeCharge.isFetchedAfterMount || activeCharge.isError) && (activeRaast.isFetchedAfterMount || activeRaast.isError)
  const resumeCharge = activeCharge.data?.find((c) => c.kind === 'charge' && (chargeBlocks(c) || c.status === 'void_pending' || c.status === 'needs_attention')) ?? null
  const resumeRaast = activeRaast.data?.find((i) => i.status === 'awaiting') ?? activeRaast.data?.find((i) => i.status === 'needs_attention') ?? null
  useEffect(() => {
    if (resumeCharge) { setWay('servd'); setTile('card'); channelSet.current = true }
    else if (resumeRaast) { setWay('servd'); setTile('raast'); channelSet.current = true }
  }, [resumeCharge, resumeRaast])
  useEffect(() => {
    const p = keenuNow.data?.push
    if (p) { setPush(p); if (p.state !== 'declined' && p.state !== 'failed') setWay('keenu') }
    if (keenuNow.data?.settlementChannel === 'servd') channelSet.current = true
  }, [keenuNow.data])
  const keenuPending = push?.state === 'pending'
  const lockedToServd = keenuNow.data?.settlementChannel === 'servd' && paidCentsOf(order) > 0

  // ── Card machine ──────────────────────────────────────────────────────────
  const termConfig = useTerminalConfig(shiftId)
  const terminal = termConfig.data ?? null
  const terminalOn = !!terminal?.enabled && terminal.terminals.length > 0
  const configSettled = !shiftId || termConfig.isSuccess || termConfig.isError
  const useTerminal = tile === 'card' && way === 'servd' && (terminalOn || !!resumeCharge) && !manualOpen
  const needsRef = tile === 'card' && way === 'servd' && configSettled && !useTerminal
  const machineLooksDown = machineDown || terminal?.online === false

  // ── On account ────────────────────────────────────────────────────────────
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const up = () => setOnline(true); const down = () => setOnline(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  const onAccountOn = useOnAccountEnabled(order.id, !done && !cod)
  const onAccountShown = onAccountOn.data === true
  const onAccountWhy: string | null = !online ? 'Needs a connection — on account is never taken offline.'
    : paidCentsOf(order) > 0 ? 'Part of this bill is already paid — on account takes the whole bill only.'
    : (order.tipCents ?? 0) > 0 ? 'This bill has a tip on it.'
    : (order.promoDiscountCents ?? 0) > 0 || !!order.promoCodeId ? 'A promo is applied to this bill.'
    : (order.walletAmountCents ?? 0) > 0 || (order.payments ?? []).some((p) => p.method === 'wallet' || p.method === 'gift_card') ? 'Wallet credit or a gift card is applied to this bill.'
    : null

  // The keypad starts at what is due; a new tender or a changed bill resets it.
  useEffect(() => { setAmount(due > 0 ? pkr(due) : ''); setFresh(true) }, [due, tile, way])

  // ── Keenu: follow a pending push until Keenu answers ──────────────────────
  useEffect(() => {
    if (!keenuPending || done) return
    const t = setInterval(() => { void checkNow(true) }, 4000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keenuPending, done, order.id])

  function finish(d: Omit<Done, 'at'>) {
    setDone({ ...d, at: Date.now() })
    paySub.current = null
    void qc.invalidateQueries({ queryKey: ['pos'] })
  }

  async function reloadBill() {
    setBillChanged(true)
    try { setOrder(await fetchOrder(order.id)) } catch { /* keep the old one */ }
    void qc.invalidateQueries({ queryKey: ['pos', 'bill', order.id] })
  }

  /** Close in servd for the tenders that run their own screen: tell the server first (§6a). */
  async function ensureServd(): Promise<boolean> {
    if (channelSet.current) return true
    try { await setServdChannel(order.id); channelSet.current = true; return true }
    catch (e) { setError(flowErrorMessage(e, 'Could not close this bill in servd')); return false }
  }

  async function pickTile(t: Tile) {
    if (holding || !resumeSettled) return
    if (t === 'on_account' && (onAccountWhy || !onAccountShown)) return
    setError(null); setBillChanged(false); setManualOpen(false)
    if (t !== 'cash' && !(await ensureServd())) return
    setTile(t)
  }

  function pickWay(w: Way) {
    if (holding || keenuPending) return
    setWay(w); setError(null)
  }

  // ── Keypad ────────────────────────────────────────────────────────────────
  function key(k: string) {
    setError(null)
    setAmount((cur) => {
      const base = fresh ? '' : cur
      if (k === 'C') return ''
      if (k === 'back') return cur.slice(0, -1)
      if (k === '.') return base.includes('.') ? base : (base || '0') + '.'
      const next = base + k
      if (/^\d*\.?\d{0,2}$/.test(next)) return next.replace(/^0+(?=\d)/, '')
      return base
    })
    setFresh(false)
  }
  function addQuick(n: number) { setAmount((cur) => pkr(toCents(fresh ? '0' : cur) + n * 100)); setFresh(false) }

  const tendered = toCents(amount)
  const excess = tile === 'cash' ? Math.max(0, tendered - due) : 0

  // Tip tile on cash: hand over due + tip and keep the excess as a tip (TILL_FLOW §6a excessAsTip).
  useEffect(() => {
    if (tile === 'cash' && tipCents > 0 && due > 0) { setAmount(pkr(due + tipCents)); setFresh(true); setKeepAsTip(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipCents, tile])

  async function payCash() {
    if (busy || !shiftId || !shown || due <= 0) return
    if (tendered < due) { setError(`Less than the ${fmtPkr(due)} due. For part cash and part card use Split.`); return }
    setBusy(true); setError(null)
    try {
      const withTip = excess > 0 && keepAsTip
      const sig = `${order.id}|cash|${due}|${tendered}|${withTip}`
      if (paySub.current?.sig !== sig) paySub.current = { sig, key: newIdempotencyKey() }
      const r = await payServd({
        orderId: order.id, shiftId, idempotencyKey: paySub.current.key, method: 'cash', amountCents: due, tenderedCents: tendered,
        ...(withTip && { excessAsTip: true }),
      })
      const change = r.payments.reduce((s, p) => s + (p.changeCents ?? 0), 0)
      finish({ way: 'servd', changeCents: withTip ? 0 : change || Math.max(0, tendered - due), keptTipCents: withTip ? excess : 0, fiscal: r.fiscal, completed: r.orderCompleted })
      if (printReceipt && r.orderCompleted) void printFinal()
    } catch (e) { await onPayError(e) } finally { setBusy(false) }
  }

  async function paySplit() {
    if (busy || !shiftId || !shown || due <= 0) return
    setBusy(true); setError(null)
    try {
      const payments: SplitTender[] = splitRows.map((r) => ({
        method: r.method, amountCents: toCents(r.amount),
        ...(r.method === 'cash' && { tenderedCents: toCents(r.amount) }),
        ...(r.method !== 'cash' && { gatewayRef: r.ref.trim() }),
        ...(r.method === 'raast' && { raastVerified: true as const }),
      }))
      const sig = `${order.id}|split|${due}|${JSON.stringify(payments)}`
      if (paySub.current?.sig !== sig) paySub.current = { sig, key: newIdempotencyKey() }
      const r = await paySplitServd({ orderId: order.id, shiftId, idempotencyKey: paySub.current.key, payments })
      finish({ way: 'servd', changeCents: 0, keptTipCents: 0, fiscal: r.fiscal, completed: r.orderCompleted })
      if (printReceipt && r.orderCompleted) void printFinal()
    } catch (e) { await onPayError(e) } finally { setBusy(false) }
  }

  async function payCardManual() {
    if (busy || !shiftId || !shown || due <= 0) return
    setBusy(true); setError(null)
    try {
      const sig = `${order.id}|card|${due}|${tipCents}|${gatewayRef}`
      if (paySub.current?.sig !== sig) paySub.current = { sig, key: newIdempotencyKey() }
      const r = await payServd({
        orderId: order.id, shiftId, idempotencyKey: paySub.current.key, method: 'card', amountCents: due + tipCents, gatewayRef: gatewayRef.trim(),
        ...(tipCents > 0 && { tipCents }),
        ...(terminalOn && manualOpen && { manualReason: 'terminal_offline' as const }),
      })
      finish({ way: 'servd', changeCents: 0, keptTipCents: tipCents, fiscal: r.fiscal, completed: r.orderCompleted })
      if (printReceipt && r.orderCompleted) void printFinal()
    } catch (e) { await onPayError(e) } finally { setBusy(false) }
  }

  async function onPayError(e: unknown) {
    if (e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID')) await reloadBill()
    if (e instanceof ApiError && e.code === 'TERMINAL_CHARGE_ACTIVE') { setTile('card'); setManualOpen(false); void activeCharge.refetch() }
    if (e instanceof ApiError && e.code === 'RAAST_AWAITING') { setTile('raast'); void activeRaast.refetch() }
    if (e instanceof ApiError && e.code === 'SETTLED_AT_KEENU') void keenuNow.refetch()
    setError(flowErrorMessage(e, 'Payment failed'))
  }

  // ── Push to Keenu ─────────────────────────────────────────────────────────
  function keenuAnswer(a: KeenuAnswer) {
    if (a.state === 'settled') {
      setPush({ pushId: a.pushId, state: 'settled', method: keenuMethod, amountCents: due, tipCents, at: new Date().toISOString(), approvalRef: a.approvalRef ?? null, reason: null })
      finish({ way: 'keenu', changeCents: 0, keptTipCents: tipCents, fiscal: a.fiscal, completed: a.orderCompleted, keenuRef: a.approvalRef ?? a.providerRef ?? null })
    } else {
      setPush((p) => ({ pushId: a.pushId, state: 'pending', method: p?.method ?? keenuMethod, amountCents: p?.amountCents ?? due, tipCents: p?.tipCents ?? tipCents, at: p?.at ?? new Date().toISOString(), approvalRef: null, reason: null }))
    }
  }
  async function doPush() {
    if (busy || !shiftId) return
    setBusy(true); setError(null)
    try {
      keenuAnswer(await pushToKeenu(order.id, { shiftId, method: keenuMethod, ...(tipCents > 0 && { tipCents }) }))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'KEENU_PUSH_STALE') void reloadBill()
      setError(flowErrorMessage(e, 'Could not send the bill to Keenu'))
    } finally { setBusy(false) }
  }
  async function checkNow(quiet = false) {
    if (!quiet) { setBusy(true); setError(null) }
    try {
      keenuAnswer(await checkKeenuPush(order.id))
      const g = await getKeenuPush(order.id)
      if (g.push) setPush(g.push)
    } catch (e) { if (!quiet) setError(flowErrorMessage(e, 'Could not ask Keenu')) } finally { if (!quiet) setBusy(false) }
  }

  // ── Printing ──────────────────────────────────────────────────────────────
  function printFinal() {
    setReceiptMsg(null)
    const duplicate = printCount > 0
    return printHtml(() => fetchReceiptHtml(order.id, useAuthStore.getState().token, { duplicate }))
      .then(() => setPrintCount((n) => n + 1))
      .catch((e: unknown) => setReceiptMsg({ ok: false, text: isPreBillRequired(e) ? 'The order is not final yet (a delivery completes when the rider hands it over) — print a KOT instead.' : flowErrorMessage(e, 'Could not load the bill') }))
  }
  function preBill() {
    setReceiptMsg(null)
    printPreBill(order.id, tile === 'cash' || way === 'keenu' && keenuMethod === 'cash' ? 'cash' : 'card', useAuthStore.getState().token)
      .then(() => setReceiptMsg({ ok: true, text: 'KOT printed. It is not a tax invoice.' }))
      .catch((e: unknown) => setReceiptMsg({ ok: false, text: preBillErrorMessage(e) }))
  }

  useDialog(panelRef, { onClose: () => onClose(!!done), dismissible: !holding && !keenuPending && !busy })

  const fiscalNow = fiscalLine(done?.fiscal ?? null)
  const live = order.items.filter((i) => i.status !== 'voided')
  const tiles: Array<{ id: Tile | 'tip'; label: string; disabled?: boolean; hint?: string }> = [
    { id: 'tip', label: 'Tip' },
    { id: 'cash', label: 'Cash' },
    { id: 'raast', label: 'Bank', hint: 'Raast QR' },
    ...(onAccountShown ? [{ id: 'on_account' as const, label: 'Credit', hint: 'On account', disabled: !!onAccountWhy }] : []),
    { id: 'card', label: 'Card', hint: 'Keenu' },
    { id: 'split', label: 'Split', hint: 'Mix tenders' },
  ]
  const tipsHere = (tile === 'card' || tile === 'raast') && way === 'servd'
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '.']

  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center" role="presentation">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={`Settle ${title}`}
        className="flex max-h-[96dvh] w-full max-w-lg flex-col rounded-t-2xl bg-kds-card outline-none sm:rounded-2xl" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-kds-border py-2 pl-5 pr-1">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-kds-text">{done ? 'Paid' : `${title} · ${orderRef(order.id)}`}</h2>
            {!done && <p className="text-xs text-kds-subtext">{live.reduce((n, i) => n + i.quantity, 0)} items · bill {fmtPkr(order.totalCents)}</p>}
          </div>
          <button type="button" data-dialog-close onClick={() => onClose(!!done)} aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4" style={{ overscrollBehavior: 'contain' }}>
          {done ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-kds-green/30 bg-kds-green/10 py-4 text-center" role="status">
                <p className="text-lg font-bold text-kds-green">{done.way === 'keenu' ? 'Settled by Keenu' : 'Payment complete'}</p>
                {done.changeCents > 0 && <p className="mt-1 text-xl font-bold text-kds-amber">Change: {fmtPkr(done.changeCents)}</p>}
                {done.keptTipCents > 0 && <p className="mt-1 text-sm text-kds-subtext">Kept as tip: {fmtPkr(done.keptTipCents)}</p>}
                {done.keenuRef && <p className="mt-1 text-xs text-kds-subtext">Keenu ref {done.keenuRef}</p>}
                {done.card && (done.card.last4 || done.card.approvalRef) && <p className="mt-1 text-xs text-kds-subtext">Card{done.card.brand ? ` ${done.card.brand}` : ''}{done.card.last4 ? ` •${done.card.last4}` : ''}{done.card.approvalRef ? ` · Ref ${done.card.approvalRef}` : ''}</p>}
                {done.raast && <p className="mt-1 px-3 text-xs text-kds-subtext">Raast QR · Ref <span className="font-mono font-bold text-kds-text">{done.raast.bankRef ?? '…'}</span> (provisional until the bank statement)</p>}
                {done.onAccount && <p className="mt-1 px-3 text-xs text-kds-subtext">{done.onAccount.name} · Account {done.onAccount.number}</p>}
                {!done.completed && order.fulfilmentType === 'delivery' && <p className="mt-2 px-3 text-sm text-kds-subtext">Paid. The order completes when the rider delivers it.</p>}
              </div>
              {done.onAccount && <p className="rounded-xl border border-kds-amber px-3 py-2 text-sm font-semibold text-kds-amber" role="status">Ask the client to sign the bill.</p>}
              {fiscalNow && <p className={`rounded-xl border border-kds-border px-3 py-2 text-sm font-semibold ${fiscalNow.tone === 'ok' ? 'text-kds-green' : fiscalNow.tone === 'muted' ? 'text-kds-subtext' : 'text-kds-amber'}`}>{fiscalNow.text}</p>}
              {receiptMsg && <p className={`text-sm ${receiptMsg.ok ? 'text-kds-subtext' : 'text-kds-red'}`} role={receiptMsg.ok ? 'status' : 'alert'}>{receiptMsg.text}</p>}
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => void printFinal()} className={ghostBtn}>{printCount === 0 ? 'Print receipt' : 'Reprint (duplicate)'}</button>
                <button type="button" onClick={() => onClose(true)} className={primaryBtn}>Done</button>
              </div>
            </div>
          ) : cod ? (
            <div className="space-y-4">
              <p className="rounded-xl border border-kds-border p-4 text-center">
                <span className="block text-sm text-kds-subtext">Cash on delivery</span>
                <span className="mt-1 block text-3xl font-black text-kds-green">{fmtPkr(order.totalCents)}</span>
                <span className="mt-2 block text-sm text-kds-subtext">The rider collects this at the door. The bill is closed in servd and the order goes to Dispatch. Nothing to take now.</span>
              </p>
              <button type="button" onClick={() => void switchCod(false)} disabled={codBusy} className={`${ghostBtn} w-full`}>{codBusy ? 'Switching…' : 'Switch to Pay now (customer pays at the counter)'}</button>
              <ErrorLine text={error} />
              <div className="grid grid-cols-2 gap-3"><button type="button" onClick={preBill} className={ghostBtn}>Print KOT</button><button type="button" onClick={() => onClose(false)} className={primaryBtn}>Done</button></div>
              {receiptMsg && <p className={`text-xs ${receiptMsg.ok ? 'text-kds-subtext' : 'text-kds-red'}`}>{receiptMsg.text}</p>}
            </div>
          ) : (
            <>
              {isDelivery && paidCentsOf(order) === 0 && !holding && !keenuPending && (
                <button type="button" onClick={() => void switchCod(true)} disabled={codBusy} className="mb-3 min-h-11 w-full rounded-lg border border-kds-border text-sm font-semibold text-kds-text hover:border-kds-green disabled:opacity-40">{codBusy ? 'Switching…' : 'Cash on delivery instead (the rider collects)'}</button>
              )}
              {/* The two ways to close the bill */}
              <div className="mb-3 grid grid-cols-2 gap-2" role="group" aria-label="How to close this bill">
                {(['servd', 'keenu'] as const).map((w) => (
                  <button key={w} type="button" aria-pressed={way === w} onClick={() => pickWay(w)} disabled={(holding || keenuPending) && way !== w || (w === 'keenu' && lockedToServd)}
                    className={`min-h-12 rounded-xl border-2 px-2 text-sm font-bold disabled:opacity-30 ${way === w ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-green'}`}>
                    {w === 'servd' ? 'Close in servd' : 'Push to Keenu'}
                    <span className="block text-[10px] font-normal uppercase tracking-wider opacity-70">{w === 'servd' ? 'Pay here' : 'Keenu POS files it'}</span>
                  </button>
                ))}
              </div>

              <div role="tablist" aria-label="Settle" className="mb-3 grid grid-cols-2 border-b border-kds-border">
                {(['process', 'summary'] as const).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                    className={`min-h-11 border-b-2 text-sm font-semibold ${tab === t ? 'border-kds-green text-kds-green' : 'border-transparent text-kds-subtext'}`}>{t === 'process' ? 'Payment Process' : 'Payment Summary'}</button>
                ))}
              </div>

              {tab === 'summary' ? (
                <div className="space-y-3 text-sm">
                  <ul className="divide-y divide-kds-border">
                    {live.map((i) => <li key={i.id} className="flex justify-between gap-2 py-2 text-kds-text"><span>{i.quantity} × {i.name}</span><span className="text-kds-subtext">{fmtPkr(i.unitPriceCents * i.quantity)}</span></li>)}
                  </ul>
                  <BillRows q={shown} unavailable={unavailable} loading={bill.isLoading} error={bill.isError ? flowErrorMessage(bill.error, 'Could not get the bill from the server') : null} />
                  {(order.payments ?? []).length > 0 && (
                    <div><p className={labelCls}>Payments</p>
                      <ul className="divide-y divide-kds-border">{(order.payments ?? []).map((p) => <li key={p.id} className="flex justify-between py-1.5 text-kds-text"><span>{p.method} · {p.status}</span><span>{fmtPkr(p.amountCents)}</span></li>)}</ul>
                    </div>
                  )}
                </div>
              ) : way === 'keenu' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label="Tender taken at Keenu">
                    {(['cash', 'card'] as const).map((m) => (
                      <button key={m} type="button" aria-pressed={keenuMethod === m} disabled={keenuPending || !!push && push.state === 'pending'} onClick={() => setKeenuMethod(m)}
                        className={`min-h-12 rounded-lg border font-semibold disabled:opacity-40 ${keenuMethod === m ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>{m === 'cash' ? 'Cash' : 'Card'}</button>
                    ))}
                  </div>
                  <BillRows q={shown} unavailable={unavailable} loading={bill.isLoading} error={bill.isError ? flowErrorMessage(bill.error, 'Could not get the bill from the server') : null} due />
                  <div>
                    <label htmlFor="kp-tip" className={labelCls}>Tip (optional, PKR)</label>
                    <NumberField id="kp-tip" decimals={2} min={0} value={tipPkr === '' ? null : Number(tipPkr)} onValueChange={(v) => setTipPkr(v == null ? '' : String(v))} disabled={keenuPending} className={inputCls} placeholder="0" />
                  </div>
                  {push && (
                    <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${push.state === 'pending' ? 'border-kds-amber text-kds-amber' : push.state === 'settled' ? 'border-kds-green text-kds-green' : 'border-kds-red text-kds-red'}`}>
                      <p className="font-bold">{push.state === 'pending' ? 'Sent to Keenu — waiting for it to settle…' : push.state === 'settled' ? 'Keenu settled this bill.' : push.state === 'declined' ? 'Keenu declined this bill.' : push.state === 'failed' ? 'Keenu could not take this bill.' : 'Needs attention — Keenu did not give a clear answer.'}</p>
                      {push.reason && <p className="mt-1">{push.reason}</p>}
                      <p className="mt-1 text-xs opacity-80">{fmtPkr(push.amountCents)} · {push.method}{push.approvalRef ? ` · ref ${push.approvalRef}` : ''}</p>
                    </div>
                  )}
                  <ErrorLine text={error} />
                  {keenuPending ? (
                    <button type="button" onClick={() => void checkNow()} disabled={busy} className={`${ghostBtn} w-full`}>{busy ? 'Asking Keenu…' : 'Check now'}</button>
                  ) : (
                    <button type="button" onClick={() => void doPush()} disabled={busy || !shown || due <= 0 || !shiftId} className={`${primaryBtn} w-full py-4 text-lg`}>
                      {busy ? 'Sending…' : push && (push.state === 'declined' || push.state === 'failed') ? `Push to Keenu again — ${fmtPkrWhole(due)}` : `Push to Keenu${shown ? ` — ${fmtPkrWhole(due)}` : ''}`}
                    </button>
                  )}
                  {!shiftId && <p className="text-xs font-semibold text-kds-amber">Open a shift before taking payment.</p>}
                </div>
              ) : (
                <>
                  <div className="mb-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }} role="group" aria-label="Tender">
                    {tiles.map((t) => {
                      const active = t.id === 'tip' ? tipOpen : tile === t.id
                      return (
                        <button key={t.id} type="button" aria-pressed={active}
                          disabled={t.id !== 'tip' && (holding && tile !== t.id || !resumeSettled || !!t.disabled)}
                          title={t.id === 'on_account' && onAccountWhy ? onAccountWhy : undefined}
                          onClick={() => (t.id === 'tip' ? setTipOpen((o) => !o) : void pickTile(t.id))}
                          className={`min-h-14 rounded-lg border px-1 text-center text-sm font-semibold disabled:opacity-30 ${active ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-green'}`}>
                          {t.label}
                          {t.hint && <span className="block text-[10px] font-normal uppercase tracking-wider opacity-70">{t.hint}</span>}
                        </button>
                      )
                    })}
                  </div>
                  {onAccountShown && onAccountWhy && <p className="mb-2 text-xs text-kds-subtext">Credit: {onAccountWhy}</p>}
                  {tipOpen && (
                    <div className="mb-3">
                      <label htmlFor="st-tip" className={labelCls}>Tip (PKR)</label>
                      <NumberField id="st-tip" decimals={2} min={0} value={tipPkr === '' ? null : Number(tipPkr)} onValueChange={(v) => setTipPkr(v == null ? '' : String(v))} disabled={holding} className={inputCls} placeholder="0" autoFocus />
                      <p className="mt-1 text-xs text-kds-subtext">{tile === 'cash' ? 'Cash: the tip is cash handed over above the bill and kept as a tip.' : tipsHere ? 'Added to the card or Raast charge.' : 'Pick Cash, Bank or Card first.'}</p>
                    </div>
                  )}
                  {billChanged && shown && <p className="mb-2 text-sm font-semibold text-kds-amber">{due <= 0 ? 'This bill has already been paid. Nothing more to take.' : `The bill changed on the server. It now reads ${fmtPkr(due)} due. Check it and pay again.`}</p>}
                  {!resumeSettled && <p className="mb-2 text-sm text-kds-subtext">Checking for a card charge or Raast payment already on this bill…</p>}

                  {tile === 'split' ? (
                    <SplitPanel due={due} shown={!!shown} rows={splitRows} setRows={setSplitRows} busy={busy} error={error} printReceipt={printReceipt} setPrintReceipt={setPrintReceipt} onPay={() => void paySplit()} unavailable={unavailable} />
                  ) : tile === 'on_account' ? (
                    !onAccountWhy && shiftId ? <OnAccountPanel orderId={order.id} shiftId={shiftId} onBillChanged={() => void reloadBill()} onCharged={(r) => finish({ way: 'servd', changeCents: 0, keptTipCents: 0, fiscal: r.fiscal, completed: true, onAccount: r.client })} /> : null
                  ) : tile === 'raast' ? (
                    <>
                      <BillRows q={shown} unavailable={unavailable} loading={bill.isLoading} error={bill.isError ? flowErrorMessage(bill.error) : null} due />
                      {resumeSettled && shiftId && shown && (due > 0 || resumeRaast) && (
                        <RaastPanel orderId={order.id} conceptId={order.conceptId} brandName={brand?.name} shiftId={shiftId} dueCents={due} tipCents={tipCents}
                          initialIntent={resumeRaast} onIntentChange={setRaastIntent}
                          onPaid={(r) => finish({ way: 'servd', changeCents: 0, keptTipCents: tipCents, fiscal: r.fiscal, completed: true, raast: r.raast })}
                          onBillChanged={() => void reloadBill()} />
                      )}
                    </>
                  ) : tile === 'card' ? (
                    <>
                      <BillRows q={shown} unavailable={unavailable} loading={bill.isLoading} error={bill.isError ? flowErrorMessage(bill.error) : null} due />
                      {!configSettled && <p className="text-sm text-kds-subtext">Checking the card machine…</p>}
                      {resumeSettled && useTerminal && shiftId && shown && due > 0 && (
                        <TerminalCharge orderId={order.id} shiftId={shiftId} config={terminal} dueCents={due} tipCents={tipCents} initialCharge={resumeCharge}
                          onBlockingChange={setChargeBlocking} onChargeChange={setRunningCharge}
                          onRecorded={(c) => { setChargeBlocking(false); finish({ way: 'servd', changeCents: 0, keptTipCents: c.tipCents, fiscal: c.fiscal, completed: true, card: { brand: c.cardBrand, last4: c.cardLast4, approvalRef: c.approvalRef } }) }}
                          onBillChanged={() => void reloadBill()} onMachineDown={() => setMachineDown(true)} />
                      )}
                      {needsRef && (
                        <form onSubmit={(e) => { e.preventDefault(); void payCardManual() }} className="space-y-3">
                          {terminalOn && <p className={`text-xs font-semibold ${machineLooksDown ? 'text-kds-amber' : 'text-kds-subtext'}`}>{machineLooksDown ? 'Card machine offline. Key the card on the machine, then enter its reference.' : 'Enter the reference from the machine slip.'}</p>}
                          <div><label htmlFor="st-ref" className={labelCls}>Terminal reference</label><input id="st-ref" value={gatewayRef} onChange={(e) => setGatewayRef(e.target.value)} className={inputCls} placeholder="Reference printed by the card machine" autoFocus /></div>
                          <ErrorLine text={error} />
                          <button type="submit" disabled={busy || !shown || due <= 0 || !gatewayRef.trim()} className={`${primaryBtn} w-full py-4 text-lg`}>{busy ? 'Processing…' : `Pay ${fmtPkrWhole(due + tipCents)}`}</button>
                        </form>
                      )}
                      {resumeSettled && useTerminal && (terminal?.allowManualRef) && !chargeBlocking && (
                        <button type="button" onClick={() => setManualOpen(true)} className={`mt-3 w-full text-center text-xs font-semibold underline ${machineLooksDown ? 'text-kds-amber' : 'text-kds-subtext'}`}>Card machine not working? Enter the machine reference</button>
                      )}
                      {!needsRef && <ErrorLine text={error} />}
                    </>
                  ) : (
                    /* Cash: due / change, the amount box, the keypad */
                    <div>
                      <div className="mb-2 grid grid-cols-2 text-center">
                        <div><p className="text-xs uppercase tracking-wider text-kds-subtext">Due</p><p className="text-2xl font-black text-kds-text">{shown ? fmtPkr(due) : '…'}</p></div>
                        <div><p className="text-xs uppercase tracking-wider text-kds-subtext">Change</p><p className="text-2xl font-black text-kds-amber">{fmtPkr(excess > 0 && !keepAsTip ? excess : 0)}</p></div>
                      </div>
                      {unavailable && <p className="mb-2 text-sm text-kds-amber">{unavailable}</p>}
                      {bill.isError && <p className="mb-2 text-sm text-kds-red">{flowErrorMessage(bill.error, 'Could not get the bill from the server')}</p>}
                      <div className="mb-2 flex items-stretch gap-2">
                        <div aria-live="polite" className="flex min-h-12 flex-1 items-center rounded-lg border border-kds-border bg-kds-bg px-3 text-2xl font-bold text-kds-green"><span className="mr-2 text-sm text-kds-subtext">Rs</span>{amount || '0'}</div>
                        <button type="button" onClick={() => key('C')} className="min-h-12 w-14 rounded-lg border border-kds-border font-bold text-kds-text active:scale-95">C</button>
                        <button type="button" onClick={() => key('back')} aria-label="Backspace" className="flex min-h-12 w-14 items-center justify-center rounded-lg border border-kds-border text-kds-text active:scale-95"><Delete size={20} aria-hidden="true" /></button>
                      </div>
                      <div className="grid grid-cols-[1fr_auto] gap-2">
                        <div className="grid grid-cols-3 gap-2">
                          {keys.map((k) => <button key={k} type="button" onClick={() => key(k)} className="min-h-14 rounded-lg border border-kds-border text-xl font-bold text-kds-text active:scale-95 active:bg-kds-border">{k}</button>)}
                        </div>
                        <div className="grid w-20 grid-rows-3 gap-2">
                          {[20, 10, 5].map((n) => <button key={n} type="button" onClick={() => addQuick(n)} className="rounded-lg border border-kds-border text-base font-bold text-kds-green active:scale-95">+{n}</button>)}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button type="button" disabled={due <= 0} onClick={() => { setAmount(pkr(due)); setFresh(true) }} className={ghostBtn}>{shown ? pkr(due) : '—'} <span className="text-xs text-kds-subtext">exact</span></button>
                        <button type="button" disabled={due <= 0} onClick={() => { setAmount(pkr(Math.ceil(due / 10000) * 10000)); setFresh(true) }} className={ghostBtn}>{shown ? pkr(Math.ceil(due / 10000) * 10000) : '—'} <span className="text-xs text-kds-subtext">round up</span></button>
                      </div>
                      {excess > 0 && (
                        <div className="mt-3 rounded-xl border border-kds-amber p-3" role="group" aria-label="What to do with the extra cash">
                          <p className="mb-2 text-sm font-semibold text-kds-amber">{fmtPkr(excess)} more than the bill</p>
                          <div className="grid grid-cols-2 gap-2">
                            <button type="button" aria-pressed={!keepAsTip} onClick={() => setKeepAsTip(false)} className={`min-h-11 rounded-lg border font-semibold ${!keepAsTip ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>Give change</button>
                            <button type="button" aria-pressed={keepAsTip} onClick={() => setKeepAsTip(true)} className={`min-h-11 rounded-lg border font-semibold ${keepAsTip ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>Keep as tip</button>
                          </div>
                        </div>
                      )}
                      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-kds-text"><input type="checkbox" checked={printReceipt} onChange={(e) => setPrintReceipt(e.target.checked)} className="h-5 w-5" /> Print Receipt</label>
                      <div className="mt-2"><ErrorLine text={error} /></div>
                      <button type="button" onClick={() => void payCash()} disabled={busy || !shown || due <= 0 || tendered < due || !shiftId || !resumeSettled}
                        className={`${primaryBtn} mt-2 w-full py-4 text-lg`}>{busy ? 'Processing…' : `Pay ${fmtPkrWhole(tendered > 0 ? (keepAsTip ? tendered : Math.min(tendered, due) || due) : due)}`}</button>
                      {!shiftId && <p className="mt-2 text-xs font-semibold text-kds-amber">Open a shift before taking payment.</p>}
                    </div>
                  )}
                </>
              )}
              {!done && (
                <div className="mt-4 border-t border-kds-border pt-3">
                  <button type="button" onClick={preBill} disabled={holding} className={`${ghostBtn} w-full py-2 text-sm`}>Print KOT</button>
                  {receiptMsg && <p className={`mt-2 text-xs ${receiptMsg.ok ? 'text-kds-subtext' : 'text-kds-red'}`} role={receiptMsg.ok ? 'status' : 'alert'}>{receiptMsg.text}</p>}
                  <p className="mt-2 text-center text-xs text-kds-subtext">{holding || keenuPending ? 'Something is waiting on this bill. Closing keeps it running; reopen the ticket to see it.' : 'Closing leaves the ticket open and unpaid. It stays under Open tickets.'}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function BillRows({ q, unavailable, loading, error, due }: {
  q: { totalCents: number; taxCents: number; serviceChargeCents: number; discountCents: number; paidCents: number; dueCents: number; taxRatePct: number | null; deliveryFeeCents?: number; deliveryFeeTaxCents?: number } | null
  unavailable: string | null
  loading: boolean
  error: string | null
  due?: boolean
}) {
  if (!q) return <p className={`mb-2 text-sm ${error ? 'text-kds-red' : unavailable ? 'text-kds-amber' : 'text-kds-subtext'}`}>{error ?? unavailable ?? (loading ? 'Getting the bill from the server…' : '')}</p>
  const row = (l: string, v: string, strong?: boolean, amber?: boolean) => <div className={`flex justify-between ${strong ? 'pt-1 text-base font-bold text-kds-text' : amber ? 'text-kds-amber' : 'text-kds-subtext'}`}><span>{l}</span><span className={strong ? 'text-kds-green' : undefined}>{v}</span></div>
  return (
    <div className="mb-3 space-y-1 rounded-xl border border-kds-border px-4 py-3 text-sm">
      {q.discountCents > 0 && row('Discount', `−${fmtPkr(q.discountCents)}`, false, true)}
      {(q.deliveryFeeCents ?? 0) > 0 && row('Delivery fee', fmtPkr(q.deliveryFeeCents!))}
      {(q.deliveryFeeTaxCents ?? 0) > 0 && row('GST on delivery fee', fmtPkr(q.deliveryFeeTaxCents!))}
      {row(`GST${q.taxRatePct != null ? ` (${q.taxRatePct}%)` : ''}`, fmtPkr(q.taxCents))}
      {q.serviceChargeCents > 0 && row('Service charge', fmtPkr(q.serviceChargeCents))}
      {row('Bill total', fmtPkr(q.totalCents))}
      {q.paidCents > 0 && row('Already paid', `−${fmtPkr(q.paidCents)}`)}
      {(due || q.paidCents > 0) && row('Due now', fmtPkr(q.dueCents), true)}
    </div>
  )
}

interface SplitRow { id: number; method: 'cash' | 'card' | 'raast'; amount: string; ref: string; verified: boolean }
let splitId = 0

// Split tender (TILL_FLOW §6a): several tenders in ONE payment that together cover what is due. Card is taken
// by the machine slip reference and Raast by its bank reference here; the card-machine charge, the Raast QR
// request and On account each take the whole bill on their own and cannot be part of a split.
function SplitPanel({ due, shown, rows, setRows, busy, error, printReceipt, setPrintReceipt, onPay, unavailable }: {
  due: number; shown: boolean; rows: SplitRow[]; setRows: (f: (r: SplitRow[]) => SplitRow[]) => void; busy: boolean; error: string | null
  printReceipt: boolean; setPrintReceipt: (v: boolean) => void; onPay: () => void; unavailable: string | null
}) {
  const sum = rows.reduce((n, r) => n + toCents(r.amount), 0)
  const left = due - sum
  const complete = shown && due > 0 && Math.abs(left) <= 2 && rows.length > 0
  const refsOk = rows.every((r) => r.method === 'cash' || (r.ref.trim() && (r.method !== 'raast' || r.verified)))
  const add = (m: SplitRow['method']) => setRows((rs) => [...rs, { id: ++splitId, method: m, amount: left > 0 ? pkr(left) : '', ref: '', verified: false }])
  const upd = (id: number, patch: Partial<SplitRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 text-center">
        <div><p className="text-xs uppercase tracking-wider text-kds-subtext">Due</p><p className="text-xl font-black text-kds-text">{shown ? fmtPkr(due) : '…'}</p></div>
        <div><p className="text-xs uppercase tracking-wider text-kds-subtext">Entered</p><p className="text-xl font-black text-kds-text">{fmtPkr(sum)}</p></div>
        <div><p className="text-xs uppercase tracking-wider text-kds-subtext">{left < 0 ? 'Over by' : 'Left'}</p><p className={`text-xl font-black ${complete ? 'text-kds-green' : 'text-kds-amber'}`}>{fmtPkr(Math.abs(left))}</p></div>
      </div>
      {unavailable && <p className="text-sm text-kds-amber">{unavailable}</p>}
      <div className="grid grid-cols-3 gap-2">
        {(['cash', 'card', 'raast'] as const).map((m) => <button key={m} type="button" onClick={() => add(m)} className={`${ghostBtn} px-2 py-2 text-sm`}>+ {m === 'cash' ? 'Cash' : m === 'card' ? 'Card' : 'Bank (Raast)'}</button>)}
      </div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="space-y-2 rounded-xl border border-kds-border p-3">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-sm font-bold text-kds-text">{r.method === 'cash' ? 'Cash' : r.method === 'card' ? 'Card' : 'Raast'}</span>
              <NumberField aria-label={`${r.method} amount (PKR)`} decimals={2} min={0} value={r.amount === '' ? null : Number(r.amount)} onValueChange={(v) => upd(r.id, { amount: v == null ? '' : String(v) })} className={inputCls} />
              <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} aria-label="Remove this tender" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-kds-red"><X size={18} aria-hidden="true" /></button>
            </div>
            {r.method !== 'cash' && <input aria-label={r.method === 'card' ? 'Terminal reference' : 'Bank reference'} value={r.ref} onChange={(e) => upd(r.id, { ref: e.target.value })} placeholder={r.method === 'card' ? 'Reference from the card machine slip' : 'Bank reference from the counter phone'} className={inputCls} />}
            {r.method === 'raast' && <label className="flex min-h-11 items-center gap-2 text-sm text-kds-text"><input type="checkbox" checked={r.verified} onChange={(e) => upd(r.id, { verified: e.target.checked })} className="h-5 w-5" /> I saw the money arrive on the counter phone</label>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-kds-subtext">A card-machine charge, a Raast QR request and On account take the whole bill on their own: pick that tender instead of Split.</p>
      <label className="flex min-h-11 items-center gap-2 text-sm text-kds-text"><input type="checkbox" checked={printReceipt} onChange={(e) => setPrintReceipt(e.target.checked)} className="h-5 w-5" /> Print Receipt</label>
      <ErrorLine text={error} />
      <button type="button" onClick={onPay} disabled={busy || !complete || !refsOk} className={`${primaryBtn} w-full py-4 text-lg`}>{busy ? 'Processing…' : `Pay ${fmtPkrWhole(sum)}`}</button>
    </div>
  )
}
