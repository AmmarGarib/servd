'use client'

// Global error boundary for the storefront. Renders when any client-side
// rendering throws below the layout. Don't drop the user on a blank page:
// give them something to press and a way to recover.
//
// Same material as the 404: butter ground, cream rubber sticker card, the
// crowd shrugging. "Try again" is a rubber TactileButton that holds a short
// loading beat before reset(), so the retry reads as something happening
// rather than a flicker. On a simmer route the template's
// data-surface="simmer" restyles all of it to the brand bible (no characters).

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CrowdPoster } from '../components/characters/CrowdPoster'
import { TactileButton, type TactileState } from '../components/tactile/TactileButton'
import s from './template.module.css'

const RETRY_BEAT_MS = 480

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // In production this is where we'd ship the error to Sentry / Datadog.
    console.error('[storefront] uncaught error:', error)
  }, [error])

  const [state, setState] = useState<TactileState>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const retry = () => {
    if (state === 'loading') return
    setState('loading')
    timer.current = window.setTimeout(() => {
      reset()
      setState('idle')
    }, RETRY_BEAT_MS)
  }

  return (
    <div className={s.boundary} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.poster} aria-hidden="true">
          <CrowdPoster cast={['fries', 'burger', 'coffee']} mode="shrug" />
        </div>
        <h1 className={s.title}>Something tipped over.</h1>
        <p className={s.body}>
          That wasn&rsquo;t supposed to happen. Try again, or head back and pick up where you left off.
          {error.digest && <span className={s.ref}>Reference: {error.digest}</span>}
        </p>
        <div className={s.actions}>
          <TactileButton
            type="button"
            state={state}
            loadingLabel="Trying again…"
            onClick={retry}
            className={`${s.rubber} ${s.primary}`}
          >
            Try again
          </TactileButton>
          <Link href="/browse" className={s.rubber}>Browse kitchens</Link>
        </div>
      </div>
    </div>
  )
}
