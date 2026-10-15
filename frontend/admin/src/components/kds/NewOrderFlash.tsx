'use client'
import { useEffect, useState } from 'react'
import { useKdsStore } from '../../store/kds'

/**
 * Full-screen green flash that briefly pulses when a new order arrives.
 * Driven by the `newOrderPulse` counter in the KDS store; mount once per page.
 */
export function NewOrderFlash() {
  const pulse = useKdsStore((s) => s.newOrderPulse)
  const [visible, setVisible] = useState(false)
  // prefers-reduced-motion: no pulse, a static highlight for the same time.
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useEffect(() => {
    if (pulse === 0) return
    setVisible(true)
    const t = setTimeout(() => setVisible(false), reduced ? 1500 : 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse])

  if (!visible) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60]"
      aria-hidden="true"
      style={reduced
        ? { boxShadow: 'inset 0 0 0 8px rgba(34,197,94,0.85)' }
        : {
            background: 'radial-gradient(circle at center, rgba(34,197,94,0.5) 0%, rgba(34,197,94,0) 70%)',
            animation: 'kds-flash 0.9s ease-out forwards',
          }}
    >
      <style>{`
        @keyframes kds-flash {
          0%   { opacity: 0; }
          15%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}
