'use client'
import { useEffect } from 'react'

// Shared inline-error toast — `role="alert"` + `aria-live="assertive"` so
// screen-reader users hear the message immediately, and a 44pt-padded
// close button so keyboard / touch users can dismiss it without precision.
// Previously duplicated in login + signup; orders/page.tsx used native
// alert() which was even worse. This is the one place to edit it.
//
// Auto-dismisses after 6s by default.

interface Props {
  message: string
  onDismiss: () => void
  /** Override the auto-dismiss delay. Pass 0 to disable auto-dismiss. */
  timeoutMs?: number
}

export function ErrorToast({ message, onDismiss, timeoutMs = 6000 }: Props) {
  useEffect(() => {
    if (timeoutMs === 0) return
    const t = setTimeout(onDismiss, timeoutMs)
    return () => clearTimeout(t)
  }, [message, onDismiss, timeoutMs])

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-4 left-1/2 z-[9999] w-[calc(100vw-2rem)] max-w-sm"
      style={{
        transform: 'translateX(-50%)',
        animation: 'slideDownFade 0.25s cubic-bezier(0.22,1,0.36,1) both',
      }}
    >
      <div
        className="flex items-start gap-3 rounded-2xl px-4 py-3.5 shadow-xl"
        style={{
          background: '#fff1f1',
          border: '1.5px solid var(--servd-danger)',
          boxShadow: '0 8px 32px rgba(239,68,68,0.18)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            borderRadius: 999,
            background: 'var(--servd-danger)',
            flex: 'none',
            marginTop: 2,
          }}
        />
        <p className="flex-1 text-sm font-bold leading-snug" style={{ color: 'var(--servd-danger)' }}>
          {message}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="text-red-400 hover:text-red-600 text-lg leading-none shrink-0 -my-2 -mr-2 px-2 py-2"
        >
          ×
        </button>
      </div>
    </div>
  )
}
