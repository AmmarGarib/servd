'use client'
import { tableName } from '../tillApi'
import { useMemo, useState } from 'react'
import { Menu, Plus, Users } from 'lucide-react'
import { fmtPkrWhole } from '../../../lib/money'
import { flowErrorMessage, useBoard, type BoardTable } from './flowApi'

// Dine In — the table board (owner's flow, step 2; data GET /floors/board).
export function TableBoard({ conceptId, onMenu, onVacant, onOccupied }: {
  conceptId: string
  onMenu: () => void
  /** A vacant table: start a ticket (Order information). */
  onVacant: (t: BoardTable) => void
  /** An occupied table: open its tickets, or (assign) change waiter / pax. */
  onOccupied: (t: BoardTable, assign: boolean) => void
}) {
  const [floorId, setFloorId] = useState<string | null>(null)
  const [show, setShow] = useState<'all' | 'occupied' | 'vacant'>('all')
  const [assign, setAssign] = useState(false)
  const board = useBoard(conceptId, floorId)
  const data = board.data

  const tables = useMemo(() => (data?.tables ?? []).filter((t) => show === 'all' || (show === 'occupied' ? t.occupied : !t.occupied)), [data, show])
  const floorTotals = floorId === null ? data?.totals : data?.floors.find((f) => f.id === floorId)?.totals ?? data?.totals

  const chip = (id: 'occupied' | 'vacant', label: string, n: number) => (
    <button type="button" aria-pressed={show === id} onClick={() => setShow(show === id ? 'all' : id)}
      className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${show === id ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-green'}`}>
      {label} ({n})
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="mr-2 text-lg font-bold text-kds-text">Dine In</h1>
        {chip('occupied', 'Occupied', floorTotals?.occupied ?? 0)}
        {chip('vacant', 'Vacant', floorTotals?.vacant ?? 0)}
        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="board-floor">Floor</label>
          <select id="board-floor" value={floorId ?? ''} onChange={(e) => setFloorId(e.target.value || null)}
            className="min-h-11 rounded-lg border border-kds-border bg-kds-bg px-3 text-sm font-semibold text-kds-text focus:border-kds-green focus:outline-none">
            <option value="">All floors</option>
            {(data?.floors ?? []).filter((f) => f.id).map((f) => <option key={f.id} value={f.id!}>{f.name}</option>)}
          </select>
          <button type="button" aria-pressed={assign} onClick={() => setAssign((a) => !a)}
            className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${assign ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-green'}`}>
            <Users size={16} aria-hidden="true" /> Waiter Assignment
          </button>
        </div>
      </div>
      {assign && <p className="bg-kds-green/10 px-4 py-2 text-sm text-kds-green" role="status">Waiter Assignment is on: tap an occupied table to change its waiter or pax.</p>}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {board.isError && <p role="alert" className="mb-3 text-sm font-semibold text-kds-red">{flowErrorMessage(board.error, 'Could not load the tables')}</p>}
        {board.isLoading && <p className="text-sm text-kds-subtext">Loading the tables…</p>}
        {data && tables.length === 0 && <p className="py-10 text-center text-sm text-kds-subtext">{data.totals.tables === 0 ? 'This brand has no tables yet — add them under Floors.' : 'No tables match.'}</p>}
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {tables.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => (t.occupied ? onOccupied(t, assign) : onVacant(t))}
                aria-label={t.occupied ? `${tableName(t.label)}, occupied${t.order?.waiter ? `, waiter ${t.order.waiter.name}` : ''}` : `${tableName(t.label)}, vacant — start an order`}
                className={`flex min-h-[104px] w-full flex-col justify-between rounded-xl border-2 p-3 text-left transition-colors active:scale-95 ${
                  t.occupied ? 'border-kds-amber bg-kds-amber/10 hover:bg-kds-amber/20' : 'border-kds-border bg-kds-card hover:border-kds-green'
                }`}>
                <span className="flex items-start justify-between gap-2">
                  <span className="text-xl font-black text-kds-text">{t.label}</span>
                  {t.occupied
                    ? <span className="rounded-full bg-kds-amber px-2 py-0.5 text-[11px] font-black uppercase text-black">Occupied</span>
                    : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-kds-green text-primary-on"><Plus size={18} aria-hidden="true" /></span>}
                </span>
                {t.occupied && t.order ? (
                  <span className="mt-2 block text-sm">
                    <span className="block truncate font-semibold text-kds-text">{t.order.waiter?.name ?? 'No waiter'}</span>
                    <span className="block text-xs text-kds-subtext">
                      {fmtPkrWhole(t.order.totalCents)}{t.openOrders > 1 ? ` · ${t.openOrders} tickets` : ''}{t.order.partySize ? ` · ${t.order.partySize} pax` : ''}
                    </span>
                  </span>
                ) : (
                  <span className="mt-2 block text-xs text-kds-subtext">Seats {t.capacity}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
