'use client'
import { useEffect, useRef } from 'react'
import { waitlistSource } from '../../components/waitlist/WaitlistForm'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// One POST /waitlist/visit per page view (with ?src=), fire-and-forget. The API
// stores only list, source, device and country — never the IP or user agent.
export function VisitBeacon() {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    const source = waitlistSource()
    try {
      void fetch(`${API_URL}/api/v1/waitlist/visit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source ? { source } : {}),
        keepalive: true,
      }).catch(() => { /* stats are best-effort */ })
    } catch { /* ignore */ }
  }, [])
  return null
}
