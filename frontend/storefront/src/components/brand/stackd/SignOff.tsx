'use client'
// The sign-off: the lockup on the deepest plum, and a stackd paper bag with
// the food crowd peeking out of it — the takeaway, still watching you — while
// the sandwich stands beside the bag waving you off. After hours the crowd in
// the bag is asleep. No order button on purpose: BrandShell's own CTA sits
// immediately below.

import { CrowdCameo, CrowdRow } from '../../world/cast/CrowdCameo'
import { useKitchen } from '../../../lib/world/kitchens'
import { LazyCrowd } from './LazyCrowd'
import { useInView } from './hooks'
import s from './signoff.module.css'
import ui from './ui.module.css'

interface Props {
  wordmarkSrc: string
  wordmarkDims: { width?: number; height?: number }
  address: string
}

const CAST = ['croissant', 'coffee', 'sandwich'] as const

export function SignOff({ wordmarkSrc, wordmarkDims, address }: Props) {
  const kitchen = useKitchen('stackd')
  const closed = kitchen.phase === 'closed'
  const { ref, inView } = useInView<HTMLDivElement>()

  return (
    <section className={s.section} aria-labelledby="stackd-signoff">
      <h2 id="stackd-signoff" className={s.mark}>
        <span className={ui.srOnly}>stackd &amp; servd</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wordmarkSrc} alt="" aria-hidden="true" {...wordmarkDims} loading="lazy" decoding="async" />
      </h2>

      <div ref={ref} className={s.stage} aria-hidden>
        <LazyCrowd
          className={s.crowd}
          cast={[...CAST]}
          sleepy={closed ? 1 : undefined}
          stageId="stackd-signoff"
          fallback={<CrowdRow kinds={[...CAST]} size={120} pose={closed ? 'sleep' : 'peek'} gap={14} stagger={260} />}
        />
        <div className={s.bag}>
          <div className={s.fold} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={s.print} src="/brand/stackd-mascot.png" alt="" width={338} height={453} loading="lazy" decoding="async" />
          <span className={s.bagMark}>stackd.</span>
          <span className={s.bagLine}>cooked here</span>
        </div>
        <span className={s.waver}>
          <CrowdCameo kind="sandwich" size={96} pose="wave" look="left" animate={inView} delay={250} />
        </span>
      </div>

      <p className={s.addr}>{address}</p>
    </section>
  )
}
