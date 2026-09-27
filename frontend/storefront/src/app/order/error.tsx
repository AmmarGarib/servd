'use client'

// Error boundary for the /order brand hub. Same boundary material as the
// root error and the 404: butter ground, cream rubber sticker card, the crowd
// shrugging, and a rubber "Try again" that holds a short loading beat before
// reset().

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { CrowdPoster } from '../../components/characters/CrowdPoster'
import { TactileButton, type TactileState } from '../../components/tactile/TactileButton'
import s from '../template.module.css'

const RETRY_BEAT_MS = 480

export default function OrderHubError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[storefront/order] error:', error) }, [error])

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
    <div className={`${s.boundary} ${s.boundaryInline}`} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.poster} aria-hidden="true">
          <CrowdPoster cast={['fries', 'burger', 'coffee']} mode="shrug" />
        </div>
        <h1 className={s.title}>Something tipped over.</h1>
        <p className={s.body}>
          We can&rsquo;t load the kitchens right now. Our kitchen system might be briefly unavailable, so give it a moment and try again.
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
          <Link href="/" className={s.rubber}>Back home</Link>
        </div>
      </div>
    </div>
  )
}
