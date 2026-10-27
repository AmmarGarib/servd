'use client'
// The CapEx tracker's wave-B forms: prepare a delivered item for the register
// (finance sends it to the CEO, the CEO capitalises now), Quick buy (a bank
// payment plus the capitalisation in one step), the return of a security
// deposit, the CEO's deposit reclass and orphan clean-up, and the withholding
// preview shared by the payment and Quick buy forms.
//
// Classes, default lives and smallwares types come from the API's response
// (GET /finance/capex assetClasses / lookups) and the register's lookups; what
// the caller may press comes from the API's capability flags. The server
// decides whether a capitalisation waits for the CEO (202) or posts (201).

import { useEffect, useMemo, useState } from 'react'
import { PaymentClassificationFields, EMPTY_PAYMENT_CLASSIFICATION, paymentClassificationBody, paymentClassificationError, type PaymentClassificationValue } from '@/components/finance/PaymentClassificationFields'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'
import { NumberField } from '../ui/NumberField'
import { useConfirm } from '../ui/ConfirmDialog'
import { BankAccountSelect } from '../finance/BankAccountSelect'
import {
  PaymentReceivedFields, ReferenceUsedBeforeNotice, receiptFieldsValid, isBankMethod, type PaymentRefUse,
} from '../finance/PaymentReceivedFields'
import { usePermissions } from '../../hooks/useCan'
import { canOpenPath } from '../../lib/moduleCatalog'
import { FA_BASE, L, Modal, ErrorLine, Notice, errorWords, inp, btnPrimary, btnGhost, money, fmtDay, fmtLife, todayIso, useFaCapabilities } from './shared'
import type { CapexLookups, CapexSupplier, Line, Orphan, Payment, Project } from './capexTypes'
import { Select } from '@/components/ui/Select'

/** Digits-only text state → NumberField value and back (the stored string stays what the API took before). */
const asNum = (v: string): number | null => (v === '' ? null : Number(v))
const fromNum = (n: number | null): string => (n == null ? '' : String(n))
/** Sensible bounds for a business date (2000-01-01 to a year ahead). */
function dateBounds(): { min: string; max: string } {
  const [y, m, d] = todayIso().split('-').map(Number) as [number, number, number]
  return { min: '2000-01-01', max: new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10) }
}
function focusId(id: string) { const el = document.getElementById(id); if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }) } }

// ─── Words ──────────────────────────────────────────────────────────────────

export const TREATMENT_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: '', label: 'Automatic', hint: 'Worked out from the item (rent advance, deposit, broker or legal fee, everything else is equipment).' },
  { key: 'capital', label: 'Equipment or fit-out', hint: 'Paid as an advance to the supplier, then capitalised onto the register.' },
  { key: 'prepaid', label: 'Rent paid in advance', hint: 'Held as a prepayment and released to rent month by month.' },
  { key: 'deposit', label: 'Refundable deposit', hint: 'Held as a security deposit until it is returned.' },
  { key: 'expense', label: 'Expense (fees)', hint: 'Broker, legal and similar fees go straight to expense.' },
]
export const TREATMENT_LABEL: Record<string, string> = { capital: 'Equipment', prepaid: 'Rent in advance', deposit: 'Deposit', expense: 'Fee, expensed' }

export const WHT_SECTION_LABEL: Record<string, string> = {
  '153_1_a': 's.153(1)(a), goods',
  '153_1_b': 's.153(1)(b), services',
  '153_1_c': 's.153(1)(c), contracts',
  '155': 's.155, rent',
  none: 'No withholding',
}
export const AUTHORITY_LABEL: Record<string, string> = {
  fbr: 'FBR (federal)', srb: 'SRB (Sindh)',
}

// ─── Data hooks ─────────────────────────────────────────────────────────────

/** GET /finance/capex/lookups: the ACTIVE company's classes, suppliers, outlets, brands and the pick-lists. */
export function useCapexLookups(enabled = true) {
  return useQuery<CapexLookups>({
    queryKey: ['capex-lookups'],
    queryFn: () => api.get<CapexLookups>('/finance/capex/lookups'),
    staleTime: 60_000,
    enabled,
    retry: false,
  })
}

interface WhtRates {
  enabled: boolean
  rates: Record<string, { filerBps: number; nonFilerBps: number }>
}

/** The company's withholding rates, when the caller's modules can open the accounting page that serves them. */
function useWhtRates() {
  const { data: me } = usePermissions()
  const open = !!me && canOpenPath('/accounting/withholding/rates', me.role, me.modules ?? [])
  return useQuery<WhtRates>({
    queryKey: ['withholding-rates'],
    queryFn: () => api.get<WhtRates>('/accounting/withholding/rates'),
    staleTime: 5 * 60_000,
    enabled: open,
    retry: false,
  })
}

/** Per CapEx line: the flags the advances report raises (overdue, delivered but not capitalised …). The one place those rules live is the server. */
export function useAdvanceFlags(): Map<string, string[]> {
  const { data: me } = usePermissions()
  const open = !!me && canOpenPath(FA_BASE, me.role, me.modules ?? [])
  const q = useQuery<{ rows: Array<{ lineId: string | null; flags: string }> }>({
    queryKey: ['fa-rep-adv', ''],
    queryFn: () => api.get(`${FA_BASE}/reports/advances`),
    staleTime: 60_000,
    enabled: open,
    retry: false,
  })
  return useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of q.data?.rows ?? []) if (r.lineId) m.set(r.lineId, r.flags.split(';').map((f) => f.trim()).filter(Boolean))
    return m
  }, [q.data])
}

/** The date the books are closed through for the active company (null when open or not readable). */
function useClosedThrough(): number | null {
  const { data: me } = usePermissions()
  const open = !!me && canOpenPath('/accounting/period-close', me.role, me.modules ?? [])
  const q = useQuery<{ locks: Array<{ lockedThrough: string }> }>({
    queryKey: ['period-close-history'],
    queryFn: () => api.get('/accounting/period-close/history'),
    staleTime: 60_000,
    enabled: open,
    retry: false,
  })
  const first = q.data?.locks[0]?.lockedThrough
  return first ? new Date(first).getTime() : null
}

// ─── Withholding preview ────────────────────────────────────────────────────

export interface WhtPreviewInput {
  grossCents: number
  /** Sales tax inside the gross that is left out of the withholding base. */
  inputTaxCents: number
  /** The line's section: a key, 'none', or empty for the supplier's default. */
  section: string | null | undefined
  supplier: CapexSupplier | undefined
  paidOn: string
  treatment?: string | null
  rates: WhtRates | undefined
}

export interface WhtPreviewResult {
  state: 'none' | 'estimate' | 'unknown'
  whtCents: number
  rateBps: number
  why: string
}

/** An estimate of the income tax withheld. The books use the server's figure when the payment is saved. */
export function previewWithholding(i: WhtPreviewInput): WhtPreviewResult {
  const none = (why: string): WhtPreviewResult => ({ state: 'none', whtCents: 0, rateBps: 0, why })
  if (i.treatment === 'deposit') return none('No income tax is withheld on a refundable deposit.')
  if (i.section === 'none') return none('This line is set to no withholding.')
  if (i.rates && !i.rates.enabled) return none('Withholding is switched off for this company.')
  const section = i.section || i.supplier?.defaultWhtSection || null
  if (!section || section === 'none') return { state: 'unknown', whtCents: 0, rateBps: 0, why: 'The section is picked when you save: the supplier\'s default, otherwise by what the line is.' }
  if (!i.rates) return { state: 'unknown', whtCents: 0, rateBps: 0, why: 'The withholding is worked out when you save.' }
  const exemptUntil = i.supplier?.whtExemptUntil ? new Date(i.supplier.whtExemptUntil).getTime() : null
  if (exemptUntil !== null && exemptUntil >= new Date(`${i.paidOn}T12:00:00+05:00`).getTime()) {
    const cert = i.supplier?.whtExemptCertNo ? ` (${i.supplier.whtExemptCertNo})` : ''
    return none(`The supplier has an exemption certificate${cert} valid until ${fmtDay(i.supplier!.whtExemptUntil)}.`)
  }
  const r = i.rates.rates[section]
  if (!r) return { state: 'unknown', whtCents: 0, rateBps: 0, why: 'The withholding is worked out when you save.' }
  // Only a confirmed filer gets the filer rate; unknown pays the non-filer rate (H33).
  const nonFiler = i.supplier?.filerStatus !== 'filer'
  const rateBps = nonFiler ? r.nonFilerBps : r.filerBps
  const base = Math.max(0, i.grossCents - i.inputTaxCents)
  const unsure = !i.supplier || i.supplier.filerStatus === 'unknown'
  return {
    state: 'estimate',
    whtCents: Math.round((base * rateBps) / 10_000),
    rateBps,
    why: `${WHT_SECTION_LABEL[section] ?? section} at ${(rateBps / 100).toFixed(rateBps % 100 === 0 ? 0 : 1)}% for a ${nonFiler ? 'non-filer' : 'filer'}${unsure ? ' (the supplier\'s filer status is not known, so the non-filer rate is used until it is confirmed. Check FBR\'s Active Taxpayers List)' : ''}.`,
  }
}

export function WhtPreview({ result, grossCents, override }: { result: WhtPreviewResult; grossCents: number; override?: number | null }) {
  const wht = override ?? result.whtCents
  const known = result.state === 'estimate' || override != null
  return (
    <div className="rounded-xl p-3 text-sm" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
      <div className="grid grid-cols-3 gap-2">
        <div><p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Gross</p><p className="font-mono text-white/90">{money(grossCents)}</p></div>
        <div><p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Income tax withheld</p><p className="font-mono text-white/90">{known ? money(wht) : 'On save'}</p></div>
        <div><p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Net paid</p><p className="font-mono font-bold text-white/95">{known ? money(grossCents - wht) : money(grossCents)}</p></div>
      </div>
      <p className="text-[11px] text-white/45 mt-2">{override != null ? 'Your own figure is used.' : result.why} {known && 'This is an estimate; the books use the figure worked out when you save.'}</p>
    </div>
  )
}

/** The supplier's exemption certificate, shown beside the form so the operator can check it. */
export function ExemptionLine({ supplier }: { supplier: CapexSupplier | undefined }) {
  if (!supplier?.whtExemptUntil) return null
  const valid = new Date(supplier.whtExemptUntil).getTime() >= Date.now()
  return (
    <p className="text-[11px]" style={{ color: valid ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
      {supplier.name} {valid ? 'has' : 'had'} an exemption certificate{supplier.whtExemptCertNo ? ` (${supplier.whtExemptCertNo})` : ''} {valid ? 'valid until' : 'that ran out on'} {fmtDay(supplier.whtExemptUntil)}.
    </p>
  )
}

/** The withholding-estimate hook the payment form uses. */
export function useWithholdingPreview() {
  const rates = useWhtRates()
  return (i: Omit<WhtPreviewInput, 'rates'>) => previewWithholding({ ...i, rates: rates.data })
}

// ─── Prepare for the register ───────────────────────────────────────────────

interface CapitaliseResponse { eventId: string; applied: boolean; assetIds: string[]; status: 'posted' | 'pending' }

const DELIVERED_STATUS = ['delivered', 'installed', 'commissioned', 'done']

export function CapitalisePanel({ project, line, onChange }: { project: Project; line: Line; onChange: () => void }) {
  const qc = useQueryClient()
  const caps = useFaCapabilities()
  const closedThrough = useClosedThrough()
  const classes = project.assetClasses
  const total = line.negotiatedCents ?? line.unitCostCents * line.quantity
  const advanced = line.ledger?.advancedCents ?? 0
  const assets = line.ledger?.assets?.filter((a) => a.status !== 'voided') ?? []
  const pendingId = line.capitalisation?.pendingEventId ?? line.ledger?.capitalisation.pendingEventId ?? null

  const [classKey, setClassKey] = useState('')
  const [name, setName] = useState(line.item)
  const [life, setLife] = useState('')
  const [salvage, setSalvage] = useState(0)
  const [inService, setInService] = useState((line.installedDate ?? line.actualDeliveryDate ?? '').slice(0, 10) || todayIso())
  const [locationId, setLocationId] = useState(project.locationId ?? '')
  // An individual asset's brand: the project's by default; '' = shared across brands.
  const [brandId, setBrandId] = useState(project.conceptId ?? '')
  const [typeKey, setTypeKey] = useState('')
  const [poolConcept, setPoolConcept] = useState(project.conceptId ?? '')
  const [inputTax, setInputTax] = useState(line.inputTaxCents)
  const [leaseEnds, setLeaseEnds] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<CapitaliseResponse | null>(null)

  useEffect(() => { if (!classKey && classes[0]) setClassKey(classes[0].key) }, [classes, classKey])
  const cls = classes.find((c) => c.key === classKey)

  const outlets = (caps.lookups?.locations ?? []).filter((l) => l.tenantId === project.tenantId)
  const brands = (caps.lookups?.brands ?? []).filter((b) => b.tenantId === project.tenantId)

  const send = useMutation({
    mutationFn: () => api.post<CapitaliseResponse>(`/finance/capex/lines/${line.id}/capitalise`, {
      classKey,
      inServiceAt: inService,
      ...(life ? { usefulLifeMonths: Number(life) } : {}),
      ...(salvage > 0 ? { salvageCents: salvage } : {}),
      ...(name.trim() && name.trim() !== line.item ? { name: name.trim() } : {}),
      ...(locationId ? { locationId } : {}),
      ...(cls && !cls.pooled ? { conceptId: brandId || null } : {}),
      ...(cls?.pooled ? { pool: { typeKey, conceptId: poolConcept || null } } : {}),
      inputTaxCents: inputTax,
      ...(leaseEnds && cls?.key === 'leasehold' ? { leaseEndsAt: leaseEnds } : {}),
      ...(note.trim() ? { reason: note.trim() } : {}),
    }, project.tenantId ? { tenantId: project.tenantId } : undefined),
    onSuccess: (r) => {
      setResult(r)
      void qc.invalidateQueries({ queryKey: ['fa-register'] })
      void qc.invalidateQueries({ queryKey: ['fa-pending-count'] })
      void qc.invalidateQueries({ queryKey: ['fa-rep-adv'] })
      onChange()
    },
  })

  // On the register already
  if (assets.length > 0) {
    return (
      <p className="text-[11px] text-success mt-2">
        On the fixed-asset register at {money(assets.reduce((s, a) => s + a.costCents, 0))}:{' '}
        {assets.map((a, i) => (
          <span key={a.id}>{i > 0 && ', '}<Link href={`${FA_BASE}/${a.id}`} className="underline">{a.assetTag ?? 'view'}</Link></span>
        ))}
      </p>
    )
  }
  if (result?.status === 'pending' || pendingId) {
    return (
      <div className="mt-2 rounded-xl p-3 text-xs" style={{ background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 30%, transparent)' }}>
        <span className="s-badge-amber mr-2">Awaiting capitalisation</span>
        Sent to the CEO. It posts to the register when approved, from the approvals inbox or{' '}
        <Link href={`${FA_BASE}/requests`} className="underline font-bold">Fixed assets &rarr; Requests</Link>.
      </div>
    )
  }
  if (result?.status === 'posted') {
    return (
      <p className="text-[11px] text-success mt-2">
        Capitalised and on the register:{' '}
        {result.assetIds.map((id, i) => <span key={id}>{i > 0 && ', '}<Link href={`${FA_BASE}/${id}`} className="underline">asset {i + 1}</Link></span>)}
      </p>
    )
  }

  if (!DELIVERED_STATUS.includes(line.status) && !line.actualDeliveryDate) return null
  if ((line.ledger?.prepaidCents ?? 0) > 0 || (line.ledger?.expensedCents ?? 0) > 0 || (line.ledger?.depositHeldCents ?? 0) > 0) return null
  if (line.treatment && line.treatment !== 'capital') return null
  if (!caps.canWrite) {
    return <p className="text-[11px] text-white/45 mt-2">Delivered. Finance prepares it for the fixed-asset register and the CEO approves.</p>
  }

  if (classes.length === 0) {
    return <p className="text-[11px] text-white/45 mt-2">Delivered. This project is not bound to a company yet, so it cannot be prepared for the register. Pick its company first.</p>
  }

  const unitsTagged = !cls?.pooled && line.quantity > 1 ? line.quantity : 0
  const delivery = inService
  const closed = closedThrough !== null && new Date(`${delivery}T23:59:59+05:00`).getTime() <= closedThrough
  const taxMissingAuthority = inputTax > 0 && !line.inputTaxAuthority
  // Owner (2026-10-14): shared equipment always says where it is. The project's own outlet counts.
  const shared = cls?.pooled ? !poolConcept : !brandId
  const hasLocation = !!locationId || !!project.locationId
  const sharedNeedsLocation = !!cls && !cls.pooled && shared && !hasLocation
  const bounds = dateBounds()
  const problems: Array<[string, string]> = []
  if (!cls) problems.push(['cap-class', 'Pick the asset class.'])
  if (!inService || inService < bounds.min || inService > bounds.max) problems.push(['cap-service', `Pick the in-service date (${bounds.min} to ${bounds.max}).`])
  if (cls?.pooled && !typeKey) problems.push(['cap-type', 'Pick the smallwares type.'])
  if (cls?.pooled && !hasLocation) problems.push(['cap-outlet', 'Pick the outlet the smallwares are at.'])
  if (sharedNeedsLocation) problems.push(['cap-outlet', 'Shared equipment needs its location. Pick the outlet it is at, or give it a brand.'])
  if (taxMissingAuthority) problems.push(['cap-tax', 'Set which authority charged the sales tax on the line before capitalising it.'])
  if (life && Number(life) < 1) problems.push(['cap-life', 'Life must be at least 1 month.'])
  const [capProblem, setCapProblem] = useState<string | null>(null)
  const submitCap = (e: React.FormEvent) => {
    e.preventDefault()
    if (send.isPending) return
    if (problems[0]) { setCapProblem(problems[0][1]); focusId(problems[0][0]); return }
    setCapProblem(null)
    send.mutate()
  }

  return (
    <form onSubmit={submitCap} noValidate className="rounded-xl p-3 mt-2" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.05)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.2)' }}>
      <p className="text-sm font-black text-white/85">Prepare for the register</p>
      <p className="text-xs text-white/60 mt-0.5">
        Delivered. Cost {money(total)}, {money(advanced)} advanced so far{total > advanced ? `, ${money(total - advanced)} still owed to the supplier` : ''}.{' '}
        {caps.canApprove ? 'You are the CEO, so it goes on the register at once.' : 'The CEO approves before it goes on the register.'}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <L t="Class">
          <Select id="cap-class" className={inp} value={classKey} onChange={(e) => { setClassKey(e.target.value); setLife('') }}>
            {classes.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
        </L>
        <L t="Name on the register"><input className={inp} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></L>
        <L t="In service from"><input id="cap-service" type="date" min={bounds.min} max={bounds.max} className={inp} value={inService} onChange={(e) => setInService(e.target.value)} /></L>
        <L t="Life (months)" hint={cls?.depreciable ? `Blank uses the class default: ${fmtLife(cls.defaultLifeMonths)}.` : 'This class is not depreciated.'}>
          <NumberField id="cap-life" min={1} max={600} className={inp} value={asNum(life)} disabled={!cls?.depreciable} onValueChange={(n) => setLife(fromNum(n))} placeholder={cls?.defaultLifeMonths ? String(cls.defaultLifeMonths) : ''} />
        </L>
        <L t="Salvage value (PKR)"><MoneyInput value={salvage} onChange={setSalvage} className={inp} /></L>
        <L t="Sales tax claimed (PKR)" hint={line.inputTaxAuthority ? `Charged by ${line.inputTaxAuthority.toUpperCase()}.` : undefined}>
          <MoneyInput id="cap-tax" value={inputTax} onChange={setInputTax} className={inp} />
        </L>
        {cls && !cls.pooled && (
          <L t="Brand">
            <Select className={inp} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">Shared across brands</option>
              {project.conceptId && !brands.some((b) => b.id === project.conceptId) && <option value={project.conceptId}>The project&rsquo;s brand</option>}
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </L>
        )}
        <L t="Asset location (outlet)" hint={sharedNeedsLocation ? 'Shared equipment needs its location' : undefined}>
          <Select id="cap-outlet" className={inp} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {project.locationId
              ? <option value="">The project&rsquo;s outlet</option>
              : <option value="" disabled={shared || !!cls?.pooled}>{shared || cls?.pooled ? 'Pick the outlet it is at' : 'No outlet'}</option>}
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </L>
        {cls?.pooled && (
          <>
            <L t="Smallwares type">
              <Select id="cap-type" className={inp} value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
                <option value="">Pick a type</option>
                {project.lookups.smallwareTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </Select>
            </L>
            <L t="Brand using them">
              <Select className={inp} value={poolConcept} onChange={(e) => setPoolConcept(e.target.value)}>
                <option value="">Shared across brands</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </L>
          </>
        )}
        {cls?.key === 'leasehold' && (
          <L t="Lease ends (optional)" hint="Depreciation stops at the lease end if that comes before the life.">
            <input type="date" min={bounds.min} className={inp} value={leaseEnds} onChange={(e) => setLeaseEnds(e.target.value)} />
          </L>
        )}
        <div className="sm:col-span-2"><L t="Note for the CEO (optional)"><input className={inp} value={note} onChange={(e) => setNote(e.target.value)} /></L></div>
      </div>

      {unitsTagged > 0 && (
        <p className="text-xs text-white/70 mt-3">{unitsTagged} assets will be tagged, one per unit, at about {money(Math.round(total / unitsTagged))} each.</p>
      )}
      {cls?.pooled && <p className="text-xs text-white/70 mt-3">The {line.quantity} unit{line.quantity === 1 ? '' : 's'} join a smallwares pool for the outlet, brand and type.</p>}
      {closed && (
        <p className="text-xs mt-2" style={{ color: 'var(--erp-warning)' }}>
          That month is closed, so the acquisition posts into the open month with a note, and depreciation catches up.
        </p>
      )}
      {taxMissingAuthority && <p className="text-xs text-s-red mt-2">Set which authority charged the sales tax on the line before capitalising it.</p>}
      {sharedNeedsLocation && <p className="text-xs mt-2" style={{ color: 'var(--erp-warning)' }}>Shared equipment needs its location. Pick the outlet it is at, or give it a brand.</p>}

      {capProblem && !taxMissingAuthority && !sharedNeedsLocation && <p role="alert" className="text-xs font-bold text-s-red mt-2">{capProblem}</p>}
      <ErrorLine error={send.error} />
      <button type="submit" disabled={send.isPending} className={`${btnPrimary} mt-3`}>
        {send.isPending ? 'Sending…' : caps.canApprove ? 'Capitalise now' : 'Send to CEO'}
      </button>
    </form>
  )
}

// ─── Quick buy ──────────────────────────────────────────────────────────────

type QuickBuyPayFrom = 'bank' | 'cash' | 'garibsons' | 'credit'
const PAY_FROM_NOTE: Record<Exclude<QuickBuyPayFrom, 'bank'>, string> = {
  cash: 'Paid from the cash on hand (1010).',
  garibsons: 'Garibsons paid the supplier: booked to Due to Garibsons (2210). No company money moves.',
  credit: 'Nothing is paid now: the supplier is owed (2012) once the CEO approves, and paid later from the project tracker.',
}

interface QuickBuyResponse {
  projectId: string; lineId: string; paymentId: string | null; eventId: string | null
  capitalisation: null | { eventId: string; status: 'posted' | 'pending'; applied: boolean; assetIds: string[]; error: { code: string; message: string } | null }
}

export function QuickBuyModal({ onClose, onDone }: { onClose: () => void; onDone: (r: QuickBuyResponse) => void }) {
  const lookups = useCapexLookups()
  const preview = useWithholdingPreview()
  const L0 = lookups.data

  const [locationId, setLocationId] = useState('')
  const [conceptId, setConceptId] = useState('')
  const [item, setItem] = useState('')
  const [classKey, setClassKey] = useState('')
  const [typeKey, setTypeKey] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitCost, setUnitCost] = useState(0)
  const [supplierId, setSupplierId] = useState('')
  const [paidAt, setPaidAt] = useState(todayIso())
  const [bankId, setBankId] = useState('')
  // Bank or cash on hand (owner, 2026-10-21: "Add cash option to Quick buy"); or booked through a liability
  // (owner, 2026-10-27): Garibsons paid it (Due to Garibsons, 2210), or owed to the supplier (on credit).
  const [payFrom, setPayFrom] = useState<QuickBuyPayFrom>('bank')
  const [ref, setRef] = useState('')
  const [tax, setTax] = useState(0)
  const [authority, setAuthority] = useState('')
  const [section, setSection] = useState('')
  const [override, setOverride] = useState(false)
  const [overrideCents, setOverrideCents] = useState(0)
  const [overrideReason, setOverrideReason] = useState('')
  const [life, setLife] = useState('')
  const [salvage, setSalvage] = useState(0)
  const [warranty, setWarranty] = useState('')
  const [notes, setNotes] = useState('')
  // Internal payment classification (2026-10-20): required, a reporting label only.
  const [payCls, setPayCls] = useState<PaymentClassificationValue>(EMPTY_PAYMENT_CLASSIFICATION)

  useEffect(() => { if (L0 && !classKey && L0.assetClasses[0]) setClassKey(L0.assetClasses[0].key) }, [L0, classKey])
  useEffect(() => { if (L0 && !locationId && L0.locations.length === 1) setLocationId(L0.locations[0]!.id) }, [L0, locationId])

  const cls = L0?.assetClasses.find((c) => c.key === classKey)
  const supplier = L0?.lookups.suppliers.find((s) => s.id === supplierId)
  const qty = Math.max(0, Math.floor(Number(quantity) || 0))
  const total = unitCost * qty
  const wht = preview({ grossCents: total, inputTaxCents: tax, section: section || undefined, supplier, paidOn: paidAt, treatment: 'capital' })
  const banksHere = (L0?.bankAccounts ?? []).filter((b) => b.accountCode)
  // Garibsons / credit move none of the company's money: no withholding here, no payment classification.
  const viaLiability = payFrom === 'garibsons' || payFrom === 'credit'

  const send = useMutation({
    mutationFn: () => api.post<QuickBuyResponse>('/finance/capex/quick-buy', {
      locationId,
      ...(cls?.pooled && conceptId ? { conceptId } : {}),
      item: item.trim(),
      classKey,
      ...(cls?.pooled ? { typeKey } : {}),
      quantity: qty,
      unitCostCents: unitCost,
      ...(supplierId ? { supplierId } : {}),
      paidAt,
      payFrom,
      ...(payFrom === 'bank' && bankId ? { bankAccountId: bankId } : {}),
      ...(payFrom !== 'credit' && ref.trim() ? { paymentRef: ref.trim() } : {}),
      inputTaxCents: tax,
      ...(tax > 0 && authority ? { inputTaxAuthority: authority } : {}),
      ...(section && !viaLiability ? { whtSection: section } : {}),
      ...(override && !viaLiability ? { whtOverrideCents: overrideCents, whtOverrideReason: overrideReason.trim() } : {}),
      ...(life ? { usefulLifeMonths: Number(life) } : {}),
      ...(salvage > 0 ? { salvageCents: salvage } : {}),
      ...(warranty ? { warrantyMonths: Number(warranty) } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(viaLiability ? {} : paymentClassificationBody(payCls)),
    }),
    onSuccess: onDone,
  })

  const bounds = dateBounds()
  const problems: Array<[string, string]> = []
  if (!locationId) problems.push(['qb-outlet', 'Pick the outlet it is for.'])
  if (!item.trim()) problems.push(['qb-item', 'Say what you bought.'])
  if (!cls) problems.push(['qb-class', 'Pick the class.'])
  if (cls?.pooled && !typeKey) problems.push(['qb-type', 'Pick the smallwares type.'])
  if (qty < 1) problems.push(['qb-qty', 'Quantity must be 1 or more.'])
  if (unitCost <= 0) problems.push(['qb-cost', 'Enter the unit cost.'])
  if (!paidAt || paidAt < bounds.min || paidAt > todayIso()) problems.push(['qb-paid', 'Pick the day it was paid (not in the future).'])
  if (payFrom === 'bank' && banksHere.length > 1 && !bankId) problems.push(['quickbuy-bank', 'Pick the bank it was paid from.'])
  if (payFrom === 'credit' && !supplierId) problems.push(['qb-supplier', 'Pick the supplier it is bought on credit from.'])
  if (tax > 0 && !authority) problems.push(['qb-auth', 'Pick the authority that charged the sales tax.'])
  if (tax > 0 && tax >= total) problems.push(['qb-tax', 'The sales tax must be less than the total.'])
  if (override && !viaLiability && !(overrideReason.trim().length >= 5 && overrideCents < total)) problems.push(['qb-why', 'Your own withholding figure needs a reason (5 characters or more) and must be below the total.'])
  if (!viaLiability && paymentClassificationError(payCls)) problems.push(['qb-cls', paymentClassificationError(payCls)!])
  const [problem, setProblem] = useState<string | null>(null)
  const submitBuy = (e: React.FormEvent) => {
    e.preventDefault()
    if (send.isPending) return
    if (!L0) return
    if (problems[0]) { setProblem(problems[0][1]); focusId(problems[0][0]); return }
    setProblem(null)
    send.mutate()
  }

  return (
    <Modal title="Buy equipment (Quick buy)" onClose={onClose} wide dirty={!send.isPending && (!!item.trim() || unitCost > 0 || !!ref.trim() || !!notes.trim())}>
      {lookups.isLoading && <p className="text-sm text-white/45">Loading…</p>}
      {lookups.error && <Notice tone="bad">{errorWords(lookups.error)}</Notice>}
      {L0 && (
        <form onSubmit={submitBuy} noValidate className="space-y-3">
          <p className="text-xs text-white/55">
            Records a purchase made today: paid from a bank account or the cash on hand, paid by Garibsons, or owed to the supplier. The equipment is prepared for the fixed-asset register in the same step.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <L t="Outlet it is for">
              <Select id="qb-outlet" className={inp} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">Pick an outlet</option>
                {L0.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </L>
            <L t="What did you buy"><input id="qb-item" className={inp} value={item} onChange={(e) => setItem(e.target.value)} maxLength={200} placeholder="Rational combi oven" /></L>
            <L t="Class">
              <Select id="qb-class" className={inp} value={classKey} onChange={(e) => { setClassKey(e.target.value); setLife(''); setTypeKey('') }}>
                {L0.assetClasses.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
            </L>
            {cls?.pooled ? (
              <L t="Smallwares type">
                <Select id="qb-type" className={inp} value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
                  <option value="">Pick a type</option>
                  {L0.lookups.smallwareTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </Select>
              </L>
            ) : <div />}
            {cls?.pooled && (
              <L t="Brand using them">
                <Select className={inp} value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
                  <option value="">Shared across brands</option>
                  {L0.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </L>
            )}
            <L t="Quantity"><NumberField id="qb-qty" min={1} max={100000} className={inp} value={asNum(quantity)} onValueChange={(n) => setQuantity(fromNum(n))} /></L>
            <L t="Unit cost, sales tax included (PKR)"><MoneyInput id="qb-cost" value={unitCost} onChange={setUnitCost} className={inp} /></L>
            <L t={payFrom === 'credit' ? 'Supplier (required on credit)' : 'Supplier'}>
              <Select id="qb-supplier" className={inp} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); const s = L0.lookups.suppliers.find((x) => x.id === e.target.value); if (s?.defaultTaxAuthority && !authority) setAuthority(s.defaultTaxAuthority) }}>
                <option value="">{payFrom === 'credit' ? 'Pick the supplier' : 'No supplier on file'}</option>
                {L0.lookups.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </L>
            <L t={payFrom === 'credit' ? 'Bought on' : 'Paid on'}><input id="qb-paid" type="date" min={bounds.min} className={inp} value={paidAt} max={todayIso()} onChange={(e) => setPaidAt(e.target.value)} /></L>
            <L t="Paid from">
              <Select id="qb-payfrom" className={inp} value={payFrom} onChange={(e) => setPayFrom(e.target.value as QuickBuyPayFrom)}>
                <option value="bank">Bank</option>
                <option value="cash">Cash on hand</option>
                <option value="garibsons">Due to Garibsons (paid by Garibsons)</option>
                <option value="credit">On credit from the supplier</option>
              </Select>
            </L>
            {payFrom === 'bank'
              ? <BankAccountSelect tenantId={L0.tenantId} value={bankId} onChange={setBankId} id="quickbuy-bank" label="Bank account" className={inp} />
              : <p className="text-[11px] text-white/45 self-end pb-2">{PAY_FROM_NOTE[payFrom]}</p>}
            {payFrom !== 'credit' && (
              <L t={payFrom === 'garibsons' ? 'Garibsons voucher no., if any' : 'Payment reference'}>
                <input className={inp} value={ref} onChange={(e) => setRef(e.target.value)} placeholder={payFrom === 'cash' ? 'Receipt number' : payFrom === 'garibsons' ? 'Optional' : 'Cheque or transfer number'} />
              </L>
            )}
          </div>

          {!cls?.pooled && <p className="text-[11px] text-white/45">Equipment is booked to the outlet and shared across brands. Smallwares can be given to a brand.</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <L t="Sales tax inside the price (PKR)"><MoneyInput id="qb-tax" value={tax} onChange={setTax} className={inp} /></L>
            <L t="Charged by">
              <Select id="qb-auth" className={inp} value={authority} onChange={(e) => setAuthority(e.target.value)} disabled={tax === 0}>
                <option value="">{tax === 0 ? 'Not needed' : 'Pick the authority'}</option>
                {L0.taxAuthorities.map((a) => <option key={a} value={a}>{AUTHORITY_LABEL[a] ?? a.toUpperCase()}</option>)}
              </Select>
            </L>
            {viaLiability ? (
              <p className="text-[11px] text-white/45 sm:col-span-2">
                {payFrom === 'credit'
                  ? 'No income tax is withheld now: it is taken when the supplier is paid.'
                  : 'No income tax is withheld here: Garibsons paid the supplier.'}
              </p>
            ) : (<>
            <L t="Income tax withholding">
              <Select className={inp} value={section} onChange={(e) => setSection(e.target.value)}>
                <option value="">Automatic (the supplier&rsquo;s default)</option>
                {L0.whtSections.map((s) => <option key={s} value={s}>{WHT_SECTION_LABEL[s] ?? s}</option>)}
              </Select>
            </L>
            <label className="flex items-center gap-2 text-sm text-white/70 self-end pb-2">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
              Use my own withholding figure
            </label>
            </>)}
          </div>
          {override && !viaLiability && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <L t="Income tax withheld (PKR)"><MoneyInput value={overrideCents} onChange={setOverrideCents} className={inp} /></L>
              <L t="Why (at least 5 characters)"><input id="qb-why" className={inp} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Certificate not on file yet" /></L>
            </div>
          )}
          {!viaLiability && <ExemptionLine supplier={supplier} />}
          {!viaLiability && total > 0 && <WhtPreview result={wht} grossCents={total} override={override ? overrideCents : null} />}

          <details className="rounded-xl p-3" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
            <summary className="text-sm font-bold text-white/70 cursor-pointer">More details (life, salvage value, warranty, notes)</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <L t="Life (months)" hint={cls?.depreciable ? `Blank uses the class default: ${fmtLife(cls.defaultLifeMonths)}.` : 'This class is not depreciated.'}>
                <NumberField min={1} max={600} className={inp} value={asNum(life)} disabled={!cls?.depreciable} onValueChange={(n) => setLife(fromNum(n))} />
              </L>
              <L t="Salvage value (PKR)"><MoneyInput value={salvage} onChange={setSalvage} className={inp} /></L>
              <L t="Warranty (months)"><NumberField min={0} max={600} className={inp} value={asNum(warranty)} onValueChange={(n) => setWarranty(fromNum(n))} /></L>
              <L t="Notes"><input className={inp} value={notes} onChange={(e) => setNotes(e.target.value)} /></L>
            </div>
          </details>

          {!viaLiability && <div id="qb-cls"><PaymentClassificationFields value={payCls} onChange={setPayCls} compact /></div>}
          {problem && <p role="alert" className="text-xs font-bold text-s-red">{problem}</p>}
          <ErrorLine error={send.error} />
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={send.isPending} className={btnPrimary}>{send.isPending ? 'Recording…'
              : payFrom === 'garibsons' ? `Record ${money(total)} paid by Garibsons and prepare for the register`
              : payFrom === 'credit' ? `Record ${money(total)} owed to the supplier and prepare for the register`
              : `Pay ${money(total - (override ? overrideCents : wht.whtCents))} and prepare for the register`}</button>
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/** What happened after a Quick buy, in words. */
export function quickBuyMessage(r: QuickBuyResponse, isCeo: boolean): { tone: 'ok' | 'wait' | 'bad'; text: string } {
  const c = r.capitalisation
  if (r.paymentId === null) {
    // On credit from the supplier: nothing paid yet.
    if (!c) return { tone: 'wait', text: 'Bought on credit. It is not on the fixed-asset register yet: finance prepares it from the item in the Project tracker.' }
    if (c.error) return { tone: 'bad', text: `Bought on credit, but putting it on the register was refused: ${c.error.message} It stays waiting in the approvals inbox.` }
    if (c.status === 'posted') return { tone: 'ok', text: 'Bought on credit and put on the fixed-asset register. The supplier is owed until paid.' }
    return { tone: 'wait', text: isCeo ? 'Bought on credit. Approve the capitalisation in Fixed assets, Requests.' : 'Bought on credit. The capitalisation is awaiting the CEO.' }
  }
  if (!c) return { tone: 'wait', text: 'Bought and paid. It is not on the fixed-asset register yet: finance prepares it from the item in the Project tracker.' }
  if (c.error) return { tone: 'bad', text: `Bought and paid, but putting it on the register was refused: ${c.error.message} It stays waiting in the approvals inbox.` }
  if (c.status === 'posted') return { tone: 'ok', text: 'Bought, paid and put on the fixed-asset register.' }
  return { tone: 'wait', text: isCeo ? 'Bought and paid. Approve the capitalisation in Fixed assets, Requests.' : 'Bought and paid. The capitalisation is awaiting the CEO.' }
}

// ─── Security deposits ──────────────────────────────────────────────────────

/** How a landlord's deposit can come back (the server's list; card aside). */
const DEPOSIT_RETURN_METHODS = ['cash', 'bank_transfer', 'bank_deposit', 'cheque'] as const

export function DepositReturnModal({ payment, line, project, onClose, onDone }: {
  payment: Payment; line: Line; project: Project; onClose: () => void; onDone: () => void
}) {
  const saved = payment
  const held = payment.paidAmountCents ?? payment.amountCents
  const [returned, setReturned] = useState(payment.depositReturnedCents)
  const [kept, setKept] = useState(payment.depositForfeitedCents)
  const [reason, setReason] = useState('')
  const [receivedAt, setReceivedAt] = useState(payment.depositReturnedAt ? payment.depositReturnedAt.slice(0, 10) : todayIso())
  const savedMethod = saved.depositReturnMethod === 'bank' ? 'bank_transfer' : saved.depositReturnMethod
  const [method, setMethod] = useState<string>(savedMethod && (DEPOSIT_RETURN_METHODS as readonly string[]).includes(savedMethod) ? savedMethod : 'bank_transfer')
  const [reference, setReference] = useState(saved.depositReturnRef ?? '')
  const [bankId, setBankId] = useState('')
  // Saved with a reference used before: say so before closing.
  const [reused, setReused] = useState<PaymentRefUse[] | null>(null)

  const send = useMutation({
    mutationFn: () => api.post<{ referenceUsedBefore?: PaymentRefUse[] }>(`/finance/capex/payments/${payment.id}/deposit-return`, {
      returnedCents: returned, forfeitedCents: kept,
      ...(kept > 0 ? { reason: reason.trim() } : {}),
      receivedAt,
      ...(returned > 0 ? { method, reference: reference.trim(), ...(isBankMethod(method) && bankId ? { bankAccountId: bankId } : {}) } : {}),
    }, project.tenantId ? { tenantId: project.tenantId } : undefined),
    onSuccess: (r) => { if (r?.referenceUsedBefore?.length) setReused(r.referenceUsedBefore); else onDone() },
  })
  const total = returned + kept
  const bounds = dateBounds()
  const [problem, setProblem] = useState<string | null>(null)
  const submitReturn = (e: React.FormEvent) => {
    e.preventDefault()
    if (send.isPending) return
    const bad: [string, string] | null =
      total <= 0 ? ['dr-returned', 'Enter what came back, or what the landlord kept.']
      : total > held ? ['dr-returned', `Returned plus kept cannot be more than the ${money(held)} held.`]
      : kept > 0 && reason.trim().length < 5 ? ['dr-why', 'Say why the landlord kept it (5 characters or more).']
      : !receivedAt || receivedAt < bounds.min || receivedAt > todayIso() ? ['dr-date', 'Pick the day the money came back (not in the future).']
      : returned > 0 && !receiptFieldsValid({ method, reference }) ? ['deposit-return-ref', 'Enter the payment reference # (the receipt, slip, transfer or cheque number).']
      : null
    if (bad) { setProblem(bad[1]); focusId(bad[0]); return }
    setProblem(null)
    send.mutate()
  }

  return (
    <Modal title={`Deposit back: ${line.item}`} onClose={reused ? onDone : onClose}
      dirty={!reused && !send.isPending && (returned !== payment.depositReturnedCents || kept !== payment.depositForfeitedCents || !!reason.trim() || !!reference.trim())}>
      <form onSubmit={submitReturn} noValidate className="space-y-3">
        <p className="text-sm text-white/65">The deposit held is <strong className="text-white/90">{money(held)}</strong>. Enter the totals; saving again corrects them.</p>
        <div className="grid grid-cols-2 gap-3">
          <L t="Returned to us (PKR)"><MoneyInput id="dr-returned" value={returned} onChange={setReturned} className={inp} /></L>
          <L t="Kept by the landlord (PKR)"><MoneyInput value={kept} onChange={setKept} className={inp} /></L>
        </div>
        {kept > 0 && <L t="Why the landlord kept it (at least 5 characters)"><input id="dr-why" className={inp} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damage to the counter" /></L>}
        <L t="Money came back on"><input id="dr-date" type="date" min={bounds.min} className={inp} value={receivedAt} max={todayIso()} onChange={(e) => setReceivedAt(e.target.value)} /></L>
        {returned > 0 && (
          <PaymentReceivedFields
            tenantId={project.tenantId}
            methods={DEPOSIT_RETURN_METHODS}
            methodLabel="Received as"
            method={method}
            onMethod={setMethod}
            reference={reference}
            onReference={setReference}
            bankAccountId={bankId}
            onBank={setBankId}
            bankLabel="Into bank account"
            idPrefix="deposit-return"
            selectClassName={inp}
            inputClassName={inp}
            labelClassName="text-[11px] font-bold text-white/50"
          />
        )}
        {total > held && <p className="text-xs text-s-red">Returned plus kept cannot be more than the {money(held)} held.</p>}
        {problem && total <= held && <p role="alert" className="text-xs font-bold text-s-red">{problem}</p>}
        <ErrorLine error={send.error} />
        {reused ? (
          <div className="space-y-3 pt-1">
            <ReferenceUsedBeforeNotice uses={reused} />
            <button type="button" onClick={onDone} className={btnPrimary}>Done</button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={send.isPending} className={btnPrimary}>{send.isPending ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
          </div>
        )}
      </form>
    </Modal>
  )
}

/** The CEO moves a legacy deposit booked as a prepayment to security deposits: a dry run first, then the real thing. */
export function ReclassDepositModal({ payment, line, project, onClose, onDone }: {
  payment: Payment; line: Line; project: Project; onClose: () => void; onDone: () => void
}) {
  const pin = project.tenantId ? { tenantId: project.tenantId } : undefined
  const dry = useMutation({
    mutationFn: () => api.post<{ amountCents: number; dryRun: boolean }>(`/finance/capex/payments/${payment.id}/reclass-deposit`, { dryRun: true }, pin),
  })
  const real = useMutation({
    mutationFn: () => api.post(`/finance/capex/payments/${payment.id}/reclass-deposit`, { dryRun: false }, pin),
    onSuccess: onDone,
  })
  useEffect(() => { dry.mutate() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={`Move to security deposits: ${line.item}`} onClose={onClose}>
      <p className="text-sm text-white/65">
        This payment was booked as rent paid in advance. If it is really a refundable security deposit, it moves out of prepaid rent into security deposits, dated today.
      </p>
      {dry.isPending && <p className="text-sm text-white/45 mt-3">Checking what would move…</p>}
      {dry.data && <p className="text-sm text-white/85 mt-3"><strong>{money(dry.data.amountCents)}</strong> would move from prepaid rent to security deposits. Nothing has been posted yet.</p>}
      <ErrorLine error={dry.error ?? real.error} />
      <div className="flex gap-2 mt-4">
        <button type="button" onClick={() => real.mutate()} disabled={!dry.data || real.isPending} className={btnPrimary}>{real.isPending ? 'Moving…' : 'Move it'}</button>
        <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
      </div>
    </Modal>
  )
}

// ─── Orphans ────────────────────────────────────────────────────────────────

/** CapEx entries on the books whose instalment or project is gone. Everyone sees them; the CEO clears them. */
export function OrphanBanner() {
  const qc = useQueryClient()
  const caps = useFaCapabilities()
  const confirm = useConfirm()
  const q = useQuery<{ orphans: Orphan[] }>({
    queryKey: ['capex-orphans'],
    queryFn: () => api.get('/finance/capex/orphans'),
    staleTime: 60_000,
    retry: false,
  })
  const reverse = useMutation({
    mutationFn: (o: Orphan) => api.post(`/finance/capex/orphans/${o.paymentId}/reverse`, {}, { tenantId: o.tenantId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['capex-orphans'] }); void qc.invalidateQueries({ queryKey: ['capex-projects'] }) },
  })
  const list = q.data?.orphans ?? []
  if (list.length === 0) return null
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>
      <p className="text-sm font-black text-s-red">{list.length} CapEx entr{list.length === 1 ? 'y' : 'ies'} on the books with nothing behind {list.length === 1 ? 'it' : 'them'}</p>
      <p className="text-xs text-white/60 mt-0.5">The instalment or its project was deleted after it was posted. {caps.canApprove ? 'Reverse each one to clear it.' : 'The CEO can reverse them.'}</p>
      <ul className="mt-2 divide-y divide-white/[0.06] text-sm">
        {list.map((o) => (
          <li key={o.paymentId} className="py-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-white/80">{money(o.amountCents)} · {o.reason === 'project_deleted' ? 'its project was deleted' : 'the instalment was deleted'}</span>
            {caps.canApprove && (
              <button className={btnGhost} disabled={reverse.isPending}
                onClick={async () => { if (await confirm({ title: `Reverse this ${money(o.amountCents)} entry?`, body: o.reason === 'project_deleted' ? 'Its project was deleted after it was posted. The entry is reversed in the books.' : 'The instalment was deleted after it was posted. The entry is reversed in the books.', confirmLabel: 'Reverse entry', danger: true })) reverse.mutate(o) }}>Reverse</button>
            )}
          </li>
        ))}
      </ul>
      <ErrorLine error={reverse.error} />
    </div>
  )
}
