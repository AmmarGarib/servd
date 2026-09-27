/**
 * haptic: a tiny physical tick for taps, adds and stamps.
 *
 * Uses the Vibration API where it exists (Android Chrome; iOS Safari has none,
 * so it is silently skipped there). Always on, except under reduced motion.
 * Never throws: haptics are garnish.
 */
export function haptic(pattern: number | number[] = 12): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  try {
    if (typeof navigator.vibrate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const safe = Array.isArray(pattern)
      ? pattern.map((n) => Math.max(0, Math.min(400, Math.round(Number(n) || 0)))).slice(0, 8)
      : Math.max(0, Math.min(400, Math.round(Number(pattern) || 0)))
    navigator.vibrate(safe)
  } catch {
    /* unsupported, blocked (no user activation yet), or a sandboxed frame */
  }
}
