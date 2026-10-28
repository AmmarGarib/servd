'use client'

// Time clock — the one punch screen in the admin (decision 32).
//
// The signed-in person clocks in or out. The punch is checked against their
// work locations (geofence) and the selfie rule, logged, and written to their
// HR attendance for the day.
//
// Everyone clocks in with their OWN login (owner, 2026-10-27): the shared
// kiosk mode (employee ID + kiosk PIN) is removed. Everyone signs in with their
// @gsfoods.pk email and password. Old kiosk punches still count.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MapPin } from 'lucide-react'
import { api } from '../../lib/api'
import MyTimeClockCard, { TZ } from '../../components/hr/MyTimeClockCard'

/** Live clock for the top of the screen: Karachi time, ticking each second. */
function useNow() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function TimeClockPage() {
  const [branch, setBranch] = useState('')
  const now = useNow()

  // The company this login is signed in to (the active one of /tenants/mine).
  const company = useQuery({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Array<{ id: string; name: string; isActive?: boolean }>>('/tenants/mine'),
    staleTime: 30_000,
  })
  const companyName = company.data?.find((t) => t.isActive)?.name ?? ''

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-md p-6">
        {/* Who and when: logo, company / branch, and the live clock */}
        <header className="mb-5 flex items-center gap-3">
          <img src="/brand/servd-logo.png" alt="servd" width={44} height={44} className="h-11 w-11 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-black text-white">{companyName || 'servd'}</p>
            <p className="flex items-center gap-1 truncate text-xs text-white/55">
              <MapPin size={12} aria-hidden="true" className="shrink-0" />{branch || 'Branch found when you punch'}
            </p>
          </div>
          <div className="shrink-0 text-right" aria-live="off">
            <p className="text-2xl font-black tabular-nums leading-none text-white">
              {now ? now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ }) : '--:--:--'}
            </p>
            <p className="mt-1 text-xs text-white/55">
              {now ? now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }) : ''}
            </p>
          </div>
        </header>
        <MyTimeClockCard variant="full" onBranch={setBranch} heading={<>
          <h1 className="text-2xl font-black text-white text-center mb-1">Time clock</h1>
          <p className="text-xs text-white/50 text-center mb-6">Your punch writes your attendance for today. Selfie and location are kept with it.</p>
        </>} />
      </div>
    </div>
  )
}
