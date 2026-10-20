'use client'
import { tableName } from './tillApi'
// TILL-R1 / FOH-21: a drawer's close was refused because unpaid tickets are
// still on it. Names them (table, ref, what is still due) and offers the two
// ways on: settle or cancel them first, or "Close anyway" — the tickets stay
// open and the Z-report lists them. Used by the till's own close (/pos/shift,
// dark till theme) and the manager's close on /reconciliation (admin theme).
import { fmtPkrWhole } from '../../lib/money'
import type { DrawerOpenTickets } from './tillApi'

const TONES = {
  till: {
    box: 'border-kds-amber bg-kds-amber/10',
    title: 'text-kds-text',
    text: 'text-kds-subtext',
    row: 'border-kds-border',
    due: 'text-kds-amber',
    error: 'text-kds-red',
    confirm: 'bg-kds-red text-white',
    back: 'border-kds-border text-kds-text',
  },
  admin: {
    box: 'border-s-border bg-s-bg-soft',
    title: 'text-s-text',
    text: 'text-s-muted',
    row: 'border-s-border',
    due: 'text-s-red',
    error: 'text-s-red',
    confirm: 'bg-secondary text-secondary-on',
    back: 'border-s-border text-s-text',
  },
} as const

interface Props {
  /** The tickets holding the close; null while they load (or when they could not be read). */
  openTickets: DrawerOpenTickets | null
  /** The server's message (the count and amount), shown when the list is unavailable. */
  message?: string
  loading?: boolean
  confirming: boolean
  error?: string | null
  tone: keyof typeof TONES
  onConfirm: () => void
  onBack: () => void
}

export function OpenTicketsCloseConfirm({ openTickets, message, loading, confirming, error, tone, onConfirm, onBack }: Props) {
  const t = TONES[tone]
  const count = openTickets?.count ?? null
  return (
    <div className={`space-y-3 rounded-xl border p-4 ${t.box}`} role="alertdialog" aria-label="Unpaid tickets on this drawer">
      <div>
        <p className={`font-bold ${t.title}`}>
          {count != null ? `${count} unpaid ticket${count === 1 ? '' : 's'} still open on this drawer` : 'Unpaid tickets are still open on this drawer'}
        </p>
        <p className={`text-xs ${t.text}`}>
          Take payment for them or have a manager cancel them, then close. Or close anyway: they stay open and are listed on the Z-report.
        </p>
      </div>

      {loading && <p className={`text-sm ${t.text}`}>Loading the tickets…</p>}
      {!loading && !openTickets && message && <p className={`text-sm ${t.text}`}>{message}</p>}
      {openTickets && openTickets.tickets.length > 0 && (
        <ul className={`divide-y rounded-lg border text-sm ${t.row}`}>
          {openTickets.tickets.map((tk) => (
            <li key={tk.id} className={`flex items-center justify-between gap-3 px-3 py-2 ${t.row}`}>
              <div className="min-w-0">
                <p className={`truncate font-semibold ${t.title}`}>
                  {tk.table ? `${tableName(tk.table)}` : 'Counter'} · #{tk.ref}
                </p>
                <p className={`text-xs ${t.text}`}>
                  {new Date(tk.placedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {tk.paidCents > 0 && ` · ${fmtPkrWhole(tk.paidCents)} paid of ${fmtPkrWhole(tk.totalCents)}`}
                </p>
              </div>
              <span className={`shrink-0 font-bold ${t.due}`}>{fmtPkrWhole(tk.dueCents)} due</span>
            </li>
          ))}
        </ul>
      )}
      {openTickets && (
        <p className={`text-xs ${t.text}`}>Still to collect: <span className={`font-bold ${t.due}`}>{fmtPkrWhole(openTickets.dueCents)}</span></p>
      )}
      {error && <p className={`text-sm ${t.error}`}>{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={confirming}
          className={`flex-1 rounded-xl border py-3 text-sm font-bold disabled:opacity-50 ${t.back}`}
        >
          Go back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className={`flex-1 rounded-xl py-3 text-sm font-bold disabled:opacity-50 ${t.confirm}`}
        >
          {confirming ? 'Closing…' : 'Close anyway'}
        </button>
      </div>
    </div>
  )
}
