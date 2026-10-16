'use client'
// Deposit drops — record cash taken to the bank. Expected from a shift = its
// drops to the safe + its counted close − the float kept in the drawer; a
// variance beyond the company's cash tolerance auto-flags. The drop posts to
// the picked bank's ledger code so the bank statement can match it. Photo of
// teller receipt strongly recommended (auto-flagged when missing for drops >
// PKR 1,000). Amounts are typed in rupees; the bank is the one picker
// (BankAccountSelect), showing only the active company's banks — the drop
// belongs to the active company and its shift must be one of that company's.
// The bank's deposit slip # (owner, 2026-10-14) sits next to the bag serial:
// it goes into the posting so the statement line can be found by it, and a
// slip # already used in the company is a warning, never a refusal.
// The slip itself is a FILE, not a URL (owner, 2026-10-16: "it should ask for
// attachment instead of URL for supporting docs"): up to 5 photos / PDFs per
// drop, on the form or attached later per row ("Attach slip"), viewed in the
// browser or downloaded. Old rows may still carry a receipt link.
// One bag may be split across several tills (owner, 2026-10-16: "One deposit
// can be split across several shifts"): "Split across tills" takes each
// till's share; the shares make up the amount. Each bag is compared with what
// is still to bank from its tills, and the night audit compares amounts.

import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { ReferenceUsedBeforeNotice, type PaymentRefUse } from '../../../components/finance/PaymentReceivedFields'
import { useActiveCompany } from '../../../lib/connectorsApi'
import { Select } from '@/components/ui/Select'
import { Modal } from '../../../components/ui/Modal'
import { Field, focusField, useSubmitOnce } from '../cash-vouchers/ui'
import { prepareReceiptFile, kb } from '../../../lib/photoPrep'

/** One deposit slip as stored (metadata only — the bytes are fetched on View / Download). */
interface SlipFile { id: string; fileName: string | null; mime: string; sizeBytes: number; createdAt: string }
/** A chosen file, ready to send. */
interface PickedSlip { fileName: string; mime: string; dataBase64: string; bytes: number }
const SLIP_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf'
const MAX_SLIPS = 5
const slipPath = (dropId: string, fileId: string) => `/trustops/deposit-drops/${dropId}/files/${fileId}`

/** Photos are compressed (JPEG, like cash-voucher receipts); PDFs go up as they are (≤ 3 MB). */
async function pickSlips(list: FileList | null, room: number): Promise<PickedSlip[]> {
  const files = Array.from(list ?? [])
  if (files.length > room) throw new Error(room <= 0 ? `A deposit takes at most ${MAX_SLIPS} files.` : `You can add ${room} more file${room === 1 ? '' : 's'} (at most ${MAX_SLIPS} per deposit).`)
  const out: PickedSlip[] = []
  for (const f of files) {
    if (f.type !== 'application/pdf' && !f.type.startsWith('image/')) throw new Error(`${f.name}: pick a photo or a PDF of the slip.`)
    const p = await prepareReceiptFile(f)
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
    const base = f.name.replace(/\.[^.]+$/, '') || 'deposit-slip'
    out.push({ fileName: p.mime === 'application/pdf' ? f.name : `${base}.jpg`, mime: p.mime, dataBase64: p.base64, bytes: p.bytes })
  }
  return out
}

interface Drop {
  id: string
  shiftId: string | null
  /** Each till's share (a split bag; a legacy drop has only shiftId). */
  allocations?: Array<{ shiftId: string; amountCents: number }>
  amountCents: number
  expectedCents: number
  varianceCents: number
  bagSerial: string | null
  slipNumber: string | null
  receiptUrl: string | null
  files?: SlipFile[]
  droppedById: string
  droppedAt: string
  notes: string | null
  withinTolerance: boolean
}
interface RecentShift { shiftId: string; cashier: string; openedAt: string; closedAt: string | null; status: string }

export default function DepositDropsPage() {
  const qc = useQueryClient()
  const { data: drops = [] } = useQuery<Drop[]>({ queryKey: ['deposit-drops'], queryFn: () => api.get('/trustops/deposit-drops'), refetchInterval: 30_000 })
  const [adding, setAdding] = useState(false)
  const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-black text-white/90">Bank deposit drops</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Record every cash drop to the bank. It posts to the bank's ledger account, and a variance against the shift (drops + counted close − float kept) auto-flags. Attach the stamped deposit slip (photo or PDF) to make the drop reconcilable on the bank statement.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ Record drop</button>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-5xl mx-auto space-y-2">
        {drops.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No drops recorded</p>
            <p className="text-sm text-white/45 mt-1">Drop cash at the bank? Record it here so we can reconcile.</p>
          </div>
        )}
        {drops.map((d) => (
          <div key={d.id} className="rounded-2xl p-5"
            style={{
              background: 'rgb(var(--fg-rgb) / 0.025)',
              border: `1px solid ${!d.withinTolerance ? 'color-mix(in srgb, var(--erp-warning) 30%, transparent)' : 'rgb(var(--fg-rgb) / 0.06)'}`,
            }}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg font-black text-white/90">{pkr(d.amountCents)}</span>
                  {d.expectedCents > 0 && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                      style={d.withinTolerance
                        ? { background: 'rgb(var(--erp-accent-rgb) / 0.15)', color: 'var(--erp-success)' }
                        : { background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)', color: 'var(--erp-warning)' }}>
                      {d.varianceCents >= 0 ? '+' : ''}{pkr(d.varianceCents)}
                    </span>
                  )}
                  {!d.receiptUrl && !(d.files?.length) && d.amountCents >= 100000 && (
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--erp-warning)' }}>No deposit slip</span>
                  )}
                </div>
                <p className="text-xs text-white/45 mt-1">
                  Still to bank from {(d.allocations?.length ?? 0) > 1 ? `${d.allocations!.length} tills` : 'the shift'} (drops + count − float, less earlier deposits): {pkr(d.expectedCents)} · {new Date(d.droppedAt).toLocaleString()}
                </p>
                {(d.allocations?.length ?? 0) > 1 && (
                  <p className="text-xs text-white/55 mt-1">
                    Split: {d.allocations!.map((a) => `${a.shiftId.slice(-8).toUpperCase()} ${pkr(a.amountCents)}`).join(' · ')}
                  </p>
                )}
                <p className="text-xs mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                  <span>
                    <span className="text-white/45">Deposit slip #: </span>
                    {d.slipNumber
                      ? <span className="font-mono font-bold text-white/85">{d.slipNumber}</span>
                      : <span style={{ color: 'var(--erp-warning)' }}>not recorded</span>}
                  </span>
                  {d.bagSerial && <span><span className="text-white/45">Bag: </span><span className="font-mono text-white/70">{d.bagSerial}</span></span>}
                </p>
                {d.notes && <p className="text-xs text-white/55 mt-1">{d.notes}</p>}
              </div>
              {d.receiptUrl && <a href={d.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary-ink hover:underline">View receipt link ↗</a>}
            </div>
            <DropSlips drop={d} />
          </div>
        ))}
      </div>

      {adding && <DropModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['deposit-drops'] }); qc.invalidateQueries({ queryKey: ['exceptions'] }) }} />}
    </div>
  )
}

function DropModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  // The drop binds to the active company; its banks are the only ones offered.
  const company = useActiveCompany()
  // Recent drawers to deposit from, so nobody types a shift UUID by hand.
  const { data: recent } = useQuery<{ shifts: RecentShift[] }>({
    queryKey: ['deposit-drop-shifts'],
    queryFn: () => api.get('/reconciliation/summary'),
    retry: false,
  })
  const shifts = recent?.shifts ?? []
  const [shiftId, setShiftId] = useState('')
  const [amountCents, setAmountCents] = useState(0)
  // A bag split across several tills: each till's share; the amount is their total.
  const [splitMode, setSplitMode] = useState(false)
  const [shares, setShares] = useState<Array<{ shiftId: string; amountCents: number }>>([{ shiftId: '', amountCents: 0 }, { shiftId: '', amountCents: 0 }])
  const shareTotal = shares.reduce((t, x) => t + x.amountCents, 0)
  const sharesComplete = shares.every((x) => x.shiftId && x.amountCents > 0) && new Set(shares.map((x) => x.shiftId)).size === shares.length
  const depositCents = splitMode ? shareTotal : amountCents
  const [bankAccountId, setBankAccountId] = useState('')
  const [bagSerial, setBagSerial] = useState('')
  const [slipNumber, setSlipNumber] = useState('')
  const [slips, setSlips] = useState<PickedSlip[]>([])
  const [slipError, setSlipError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const slipInput = useRef<HTMLInputElement>(null)
  async function addSlips(list: FileList | null) {
    setSlipError(null); setPreparing(true)
    try { const more = await pickSlips(list, MAX_SLIPS - slips.length); setSlips((s) => [...s, ...more]) }
    catch (e) { setSlipError((e as Error).message) }
    finally { setPreparing(false); if (slipInput.current) slipInput.current.value = '' }
  }
  const [notes, setNotes] = useState('')
  // Saved but the ledger refused the posting (e.g. a closed period): the drop
  // stands and finance is flagged to re-post it — say so before closing.
  const [notBooked, setNotBooked] = useState<string | null>(null)
  // Saved with a slip # used before in this company: a warning, shown before closing.
  const [reused, setReused] = useState<PaymentRefUse[] | null>(null)

  const save = useMutation({
    mutationFn: () => api.post<{ posted?: boolean; postingError?: string | null; referenceUsedBefore?: PaymentRefUse[] }>('/trustops/deposit-drops', {
      ...(splitMode ? { shifts: shares } : { shiftId: shiftId || null }),
      bankAccountId: bankAccountId || null,
      amountCents: depositCents,
      bagSerial: bagSerial || null,
      slipNumber: slipNumber.trim() || null,
      notes: notes || null,
      files: slips.map(({ fileName, mime, dataBase64 }) => ({ fileName, mime, dataBase64 })),
    }),
    onSuccess: (r) => {
      const uses = r?.referenceUsedBefore?.length ? r.referenceUsedBefore : null
      if (r?.postingError || uses) { setNotBooked(r?.postingError ?? null); setReused(uses) }
      else onSaved()
    },
  })

  const done = !!notBooked || !!reused
  const close = done ? onSaved : onClose
  const [tried, setTried] = useState(false)
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    if (splitMode && !sharesComplete) { focusField('dd-share-0'); return false }
    if (depositCents <= 0) { focusField(splitMode ? 'dd-share-0' : 'dd-amount'); return false }
    if (preparing) return false
    save.mutate()
    return true
  })
  return <Modal title="Record bank deposit" onClose={close} dirty={!done && !save.isPending && (depositCents > 0 || !!slipNumber.trim() || !!bagSerial.trim() || !!notes.trim() || slips.length > 0)}
    footer={
      <div className="flex justify-between gap-3">
        {done ? (
          <button type="button" onClick={onSaved} className="ml-auto rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90">Done</button>
        ) : (
          <>
            <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
            <button type="submit" form="dd-form" disabled={save.isPending || preparing} className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">{save.isPending ? 'Saving…' : 'Record drop'}</button>
          </>
        )}
      </div>
    }>
    <form id="dd-form" onSubmit={submit} className="space-y-3" noValidate>
      <label className="flex items-center gap-2 text-sm text-white/70">
        <input type="checkbox" checked={splitMode} onChange={(e) => setSplitMode(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
        One bag for several tills — split it across them
      </label>
      {!splitMode ? (
        <>
          <Field label="Shift (optional — for the variance check)">
            {shifts.length > 0 ? (
              <Select id="dd-shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)} className={fieldCls}>
                <option value="">— not from one shift —</option>
                {shifts.map((s) => (
                  <option key={s.shiftId} value={s.shiftId}>
                    {s.cashier} · {new Date(s.openedAt).toLocaleString()}{s.status === 'open' ? ' (open)' : ''}
                  </option>
                ))}
              </Select>
            ) : (
              <input id="dd-shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)} placeholder="Shift UUID — leave blank to skip the variance check" className={fieldCls} />
            )}
          </Field>
          <Field label="Amount counted at drop (PKR) *" error={tried && amountCents <= 0 ? 'Enter the amount counted.' : ''}>
            <MoneyInput id="dd-amount" value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
          </Field>
        </>
      ) : (
        <Field label="Each till's share (PKR) *" hint={`Bag total: PKR ${(shareTotal / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`}
          error={tried && !sharesComplete ? 'Pick a different till and an amount on every line.' : ''}>
          <div className="space-y-2">
            {shares.map((x, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2 items-center">
                {shifts.length > 0 ? (
                  <Select id={`dd-share-${i}`} value={x.shiftId} onChange={(e) => setShares((all) => all.map((y, j) => (j === i ? { ...y, shiftId: e.target.value } : y)))} className={fieldCls} aria-label={`Till ${i + 1}`}>
                    <option value="">— pick a till —</option>
                    {shifts.map((s) => (
                      <option key={s.shiftId} value={s.shiftId}>
                        {s.cashier} · {new Date(s.openedAt).toLocaleString()}{s.status === 'open' ? ' (open)' : ''}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <input id={`dd-share-${i}`} value={x.shiftId} onChange={(e) => setShares((all) => all.map((y, j) => (j === i ? { ...y, shiftId: e.target.value } : y)))} placeholder="Shift UUID" className={fieldCls} aria-label={`Till ${i + 1}`} />
                )}
                <MoneyInput value={x.amountCents} onChange={(v) => setShares((all) => all.map((y, j) => (j === i ? { ...y, amountCents: v } : y)))} className={fieldCls} ariaLabel={`Till ${i + 1} share in rupees`} />
                <button type="button" disabled={shares.length <= 1} onClick={() => setShares((all) => all.filter((_, j) => j !== i))}
                  className="text-xs font-bold text-s-red disabled:opacity-40">Remove</button>
              </div>
            ))}
            <button type="button" disabled={shares.length >= 20} onClick={() => setShares((all) => [...all, { shiftId: '', amountCents: 0 }])}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-white/65 hover:text-white hover:border-primary disabled:opacity-50">+ Add a till</button>
          </div>
        </Field>
      )}
      <BankAccountSelect tenantId={company?.id} value={bankAccountId} onChange={setBankAccountId} id="deposit-bank" label="Bank account" className={fieldCls} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Deposit slip #"><input value={slipNumber} onChange={(e) => setSlipNumber(e.target.value)} maxLength={100} placeholder="From the bank's stamped slip" autoComplete="off" className={fieldCls + ' font-mono'} /></Field>
        <Field label="Tamper-bag serial"><input value={bagSerial} onChange={(e) => setBagSerial(e.target.value)} className={fieldCls + ' font-mono'} /></Field>
      </div>
      <Field label="Deposit slip / receipt" hint={`Photo or PDF of the bank's stamped slip — up to ${MAX_SLIPS} files.`} error={slipError ?? undefined}>
        <input ref={slipInput} id="dd-slips" type="file" multiple accept={SLIP_ACCEPT} className="hidden" onChange={(e) => void addSlips(e.target.files)} />
        <div className="space-y-2">
          {slips.length > 0 && (
            <ul className="space-y-1">
              {slips.map((f, i) => (
                <li key={`${f.fileName}-${i}`} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                  <span className="min-w-0 break-all"><span className="font-bold text-white/85">{f.fileName}</span><span className="text-white/45"> · {kb(f.bytes)}</span></span>
                  <button type="button" onClick={() => setSlips((s) => s.filter((_, j) => j !== i))} className="shrink-0 font-bold text-s-red">Remove</button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => slipInput.current?.click()} disabled={preparing || slips.length >= MAX_SLIPS}
            className="rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-white/65 hover:text-white hover:border-primary disabled:opacity-50">
            {preparing ? 'Preparing…' : slips.length ? '+ Attach another file' : '+ Attach slip'}
          </button>
        </div>
      </Field>
      <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
    </form>
      {save.error && <div role="alert" className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>{(save.error as Error).message}</div>}
      {notBooked && (
        <div role="alert" className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 30%, transparent)' }}>
          The drop is saved, but it is not in the books yet ({notBooked}). Finance has been flagged to post it.
        </div>
      )}
      <ReferenceUsedBeforeNotice uses={reused} />
  </Modal>
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"

/** A drop's slip files: View (photos / PDFs in the browser, no download), Download, and "Attach slip" for one that arrives later. */
function DropSlips({ drop }: { drop: Drop }) {
  const qc = useQueryClient()
  const files = drop.files ?? []
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<{ name: string; url: string; kind: 'image' | 'pdf' } | null>(null)
  const nameOf = (f: SlipFile) => f.fileName || `Deposit slip ${f.id.slice(0, 6)}`

  async function attach(list: FileList | null) {
    setError(null); setBusy(true)
    try {
      const picked = await pickSlips(list, MAX_SLIPS - files.length)
      if (picked.length) {
        await api.post(`/trustops/deposit-drops/${drop.id}/files`, { files: picked.map(({ fileName, mime, dataBase64 }) => ({ fileName, mime, dataBase64 })) })
        await qc.invalidateQueries({ queryKey: ['deposit-drops'] })
        void qc.invalidateQueries({ queryKey: ['exceptions'] })
      }
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false); if (input.current) input.current.value = '' }
  }
  async function view(f: SlipFile) {
    try {
      const blob = await api.fetchBlob(slipPath(drop.id, f.id))
      setViewing({ name: nameOf(f), url: URL.createObjectURL(new Blob([blob], { type: f.mime })), kind: f.mime === 'application/pdf' ? 'pdf' : 'image' })
    } catch (e) { setError((e as Error).message) }
  }
  function closeViewer() {
    if (viewing) URL.revokeObjectURL(viewing.url)
    setViewing(null)
  }
  async function download(f: SlipFile) {
    try { await api.download(slipPath(drop.id, f.id), nameOf(f)) }
    catch (e) { setError((e as Error).message) }
  }

  return (
    <div className="mt-3 pt-3 space-y-2" style={{ borderTop: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 flex-wrap text-xs">
              <span className="min-w-0 break-all"><span className="font-bold text-white/85">{nameOf(f)}</span><span className="text-white/45"> · {kb(f.sizeBytes)}</span></span>
              <span className="flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => void view(f)} className="font-bold" style={{ color: 'var(--erp-primary)' }}>View</button>
                <button type="button" onClick={() => void download(f)} className="font-bold" style={{ color: 'var(--erp-primary)' }}>Download</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {files.length < MAX_SLIPS && (
        <>
          <input ref={input} type="file" multiple accept={SLIP_ACCEPT} className="hidden" onChange={(e) => void attach(e.target.files)} />
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="text-xs font-bold disabled:opacity-50" style={{ color: 'var(--erp-primary)' }}>
            {busy ? 'Uploading…' : files.length ? '+ Attach another file' : '+ Attach slip'}
          </button>
        </>
      )}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
      {viewing && (
        <Modal title={viewing.name} onClose={closeViewer} wide>
          {viewing.kind === 'pdf' ? (
            <iframe src={viewing.url} title={viewing.name} className="w-full rounded-lg" style={{ height: '75vh', border: '1px solid var(--border)' }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={viewing.url} alt={viewing.name} className="mx-auto max-h-[75vh] max-w-full rounded-lg object-contain" />
          )}
        </Modal>
      )}
    </div>
  )
}
