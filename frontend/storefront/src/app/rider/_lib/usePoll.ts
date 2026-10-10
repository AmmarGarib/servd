'use client'
// Run `fn` now and then every `intervalMs` while `enabled` and the page is
// visible; run it again the moment the page comes back into view. One run at
// a time — a slow network never stacks requests.

import { useEffect, useRef } from 'react'

export function usePoll(fn: () => Promise<void> | void, intervalMs: number, enabled: boolean): void {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      if (!alive) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void run(), intervalMs)
    }
    const run = async () => {
      if (!alive || running) return
      if (document.visibilityState === 'hidden') { schedule(); return }
      running = true
      try {
        await fnRef.current()
      } catch { /* the caller reports its own errors */ }
      finally {
        running = false
        schedule()
      }
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (timer) clearTimeout(timer)
      void run()
    }

    void run()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, intervalMs])
}
