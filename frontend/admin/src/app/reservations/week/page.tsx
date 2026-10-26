'use client'

// Week view — 7-day grid showing reservation density. Hover a day to see who.
// Click a day → switch back to /reservations?date=YYYY-MM-DD.

import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Star } from 'lucide-react'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '../../../lib/api'
import { todayPktIso } from '../../../lib/money'
import { useBrandFilter } from '../../../store/brandFilter'
import { Select } from '@/components/ui/Select'

interface Concept { id: string; name: string }
interface Reservation {
  id: string; partySize: number; startTime: string; status: string
  guestName: string; isVip: boolean
  table?: { id: string; label: string } | null
}

// Days here are instants at Karachi midnight (= 19:00 UTC the day before), so the Karachi
// calendar day is read by shifting +5h — d.toISOString().slice(0,10) would give the day before.
const KHI = 'Asia/Karachi'
const pktYmd = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const pktHour = (iso: string) => Number(new Date(iso).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: KHI })) % 24

function startOfWeek(iso: string): Date {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00+05:00`)
  // Mon-start week. The weekday comes from the Karachi DATE itself: d is
  // Karachi midnight (19:00Z the day before), so d.getUTCDay() would be a day early.
  const dow = new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()
  const offset = dow === 0 ? 6 : dow - 1
  return new Date(d.getTime() - offset * 86_400_000)
}

const STATUS_DOT: Record<string, string> = {
  booked:    'bg-blue-500',
  confirmed: 'bg-s-teal',
  seated:    'bg-primary',
  completed: 'bg-gray-400',
  no_show:   'bg-s-red',
  cancelled: 'bg-gray-300',
  // Past capacity, waiting for the CEO (owner C10, 2026-10-26).
  pending_approval: 'bg-s-amber',
}

export default function ReservationsWeekPage() {
  const router = useRouter()
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [anchor,    setAnchor]    = useState(todayPktIso())

  const concepts = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })

  if (!conceptId && concepts.data && concepts.data.length > 0) setConceptId(concepts.data[0]!.id)

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor])
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000)),
    [weekStart],
  )

  // Pull reservations for all 7 days in parallel
  const week = useQuery({
    queryKey: ['reservations-week', conceptId, weekStart.toISOString()],
    queryFn: async () => {
      const dayLists = await Promise.all(days.map((d) => {
        const iso = pktYmd(d)
        return api.get<Reservation[]>(`/reservations?conceptId=${conceptId}&date=${iso}`)
      }))
      return dayLists
    },
    enabled: !!conceptId,
  })

  const hours = Array.from({ length: 14 }, (_, i) => i + 10)  // 10:00 → 23:00

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/reservations" className="inline-flex min-h-11 items-center gap-1 text-xs text-s-muted hover:text-s-text"><ArrowLeft size={14} aria-hidden="true" /> Day view</Link>
          <h1 className="text-xl font-bold text-s-text">Reservations · week</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)}
            className="min-h-11 bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <button onClick={() => setAnchor(pktYmd(new Date(weekStart.getTime() - 7 * 86_400_000)))}
            className="min-h-11 s-btn-secondary text-xs"><ArrowLeft size={14} aria-hidden="true" /> Prev</button>
          <span className="text-xs text-s-muted whitespace-nowrap">
            {days[0]!.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: KHI })} – {days[6]!.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: KHI })}
          </span>
          <button onClick={() => setAnchor(pktYmd(new Date(weekStart.getTime() + 7 * 86_400_000)))}
            className="min-h-11 s-btn-secondary text-xs">Next <ArrowRight size={14} aria-hidden="true" /></button>
          <button onClick={() => setAnchor(todayPktIso())} className="min-h-11 s-btn-secondary text-xs">Today</button>
        </div>
      </header>

      <div className="p-4 max-w-7xl mx-auto">
        <div className="s-card overflow-hidden">
          <div className="grid grid-cols-[60px_repeat(7,minmax(0,1fr))] border-b border-s-border bg-s-bg-soft">
            <div></div>
            {days.map((d) => (
              <button
                key={d.toISOString()}
                onClick={() => router.push(`/reservations?date=${pktYmd(d)}`)}
                className="px-2 py-3 text-center hover:bg-s-bg-soft"
              >
                <p className="text-xs uppercase text-s-muted tracking-wider">
                  {d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: KHI })}
                </p>
                <p className="text-sm font-bold text-s-text">{pktYmd(d).slice(8)}</p>
              </button>
            ))}
          </div>

          {hours.map((h) => (
            <div key={h} className="grid grid-cols-[60px_repeat(7,minmax(0,1fr))] border-b border-s-border min-h-[44px]">
              <div className="px-2 py-1 text-xs text-s-muted font-mono border-r border-s-border">
                {String(h).padStart(2, '0')}:00
              </div>
              {days.map((d, idx) => {
                const list = week.data?.[idx] ?? []
                const inHour = list.filter((r) => pktHour(r.startTime) === h)
                return (
                  <div key={d.toISOString()} className="border-r border-s-border last:border-0 p-1 space-y-1">
                    {inHour.map((r) => (
                      <div
                        key={r.id}
                        title={`${r.guestName} · ${r.partySize}p · ${r.table?.label ?? 'unseated'}`}
                        className="text-xs px-1.5 py-0.5 rounded bg-s-surface border border-s-border truncate flex items-center gap-1"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[r.status] ?? 'bg-gray-400'}`} />
                        <span className="truncate">{r.isVip && <Star size={10} aria-hidden="true" className="inline-block align-[-1px] mr-0.5" />}{r.guestName} · {r.partySize}p</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-s-muted">
          {Object.entries(STATUS_DOT).map(([k, c]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${c}`} /> {k === 'pending_approval' ? 'waiting for the CEO' : k}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
