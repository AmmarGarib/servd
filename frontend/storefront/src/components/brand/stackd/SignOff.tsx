'use client'
// The sign-off: the lockup on the deepest plum, and a stackd paper bag with
// the food crowd peeking out of it — the takeaway, still watching you. No
// order button on purpose: BrandShell's own CTA sits immediately below.

import { LazyCrowd } from './LazyCrowd'
import s from './signoff.module.css'
import ui from './ui.module.css'

interface Props {
  wordmarkSrc: string
  wordmarkDims: { width?: number; height?: number }
  address: string
}

export function SignOff({ wordmarkSrc, wordmarkDims, address }: Props) {
  return (
    <section className={s.section} aria-labelledby="stackd-signoff">
      <h2 id="stackd-signoff" className={s.mark}>
        <span className={ui.srOnly}>stackd &amp; servd</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wordmarkSrc} alt="" aria-hidden="true" {...wordmarkDims} loading="lazy" decoding="async" />
      </h2>

      <div className={s.stage} aria-hidden>
        <LazyCrowd className={s.crowd} cast={['croissant', 'coffee', 'sandwich']} />
        <div className={s.bag}>
          <div className={s.fold} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={s.print} src="/brand/stackd-mascot.png" alt="" width={338} height={453} loading="lazy" decoding="async" />
          <span className={s.bagMark}>stackd.</span>
          <span className={s.bagLine}>cooked here</span>
        </div>
      </div>

      <p className={s.addr}>{address}</p>
    </section>
  )
}
