'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { Coffee, Coins, Gem, Mail, MessageCircle, type LucideIcon } from 'lucide-react'
import { brandAccent } from '../../../lib/concept'
import { BRAND_LOCATIONS, whatsappLink } from '../../../lib/brandLocations'
import { Reveal, RevealGroup, RevealItem } from '../motion'
import s from './home.module.css'

// Insiders — servd loyalty membership pitch.
//
// Per-brand perks, per the loyalty-program skill: simmer (premium) gets
// exclusive recognition framing — no points, no "buy N get 1," no coupony
// language; stackd + flipd (casual, higher-frequency) get a clean generous
// points mechanic. Copy is signed off — edit wording, not tone.

interface Perk {
  slug: string
  Icon: LucideIcon
  tag: string
  head: string
  body: string
  featured: boolean
}

const PERKS: Perk[] = [
  {
    slug: 'simmer',
    Icon: Gem,
    tag: 'simmer · regulars',
    head: 'The regulars’ list',
    body: 'Quiet recognition. First word on the next menu drop. A held table when the room is full. Now and then the chef sends out a plate. No card, no points — you’re known here.',
    featured: false,
  },
  {
    slug: 'stackd',
    Icon: Coffee,
    tag: 'stackd · counter club',
    head: 'Five coffees in, the sixth is on us',
    body: 'Buy five drinks at stackd and the sixth is on the house. Insiders also get first look at the pastry case before the morning bake goes out to the floor.',
    featured: true,
  },
  {
    slug: 'flipd',
    Icon: Coins,
    tag: 'Flipd · points',
    head: 'Points on every box',
    body: 'Earn 1 point per Rs. 10 spent at Flipd. Free weekday lunch delivery for members. Redeem points for a meal at 2,000.',
    featured: false,
  },
]

export function Insiders() {
  return (
    <section id="insiders" className={`hub-section hub-grain ${s.insiders}`} aria-labelledby="insiders-title">
      <div aria-hidden className="hub-glow" style={{ width: '40rem', height: '40rem', top: '-14rem', right: '-12rem', background: 'var(--hub-plum)', opacity: 0.7 }} />
      <div aria-hidden className="hub-glow" style={{ width: '26rem', height: '26rem', bottom: '-10rem', left: '-8rem', background: 'var(--hub-lilac)', opacity: 0.12 }} />

      <div className={`hub-container ${s.insidersInner}`}>
        <Reveal className={s.sectionHead}>
          <div>
            <p className="hub-eyebrow hub-eyebrow--accent" style={{ margin: 0 }}>Insiders · free to join</p>
            <h2 id="insiders-title" className={`hub-display ${s.h2}`}>
              The best stuff <em>doesn&rsquo;t get listed.</em>
            </h2>
          </div>
          <p className="hub-lead" style={{ margin: 0 }}>
            Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.
          </p>
        </Reveal>

        <RevealGroup className={s.perks}>
          {PERKS.map(({ slug, Icon, tag, head, body, featured }) => (
            <RevealItem key={slug}>
              <div
                className={`hub-card ${s.perk} ${featured ? s.perkFeatured : ''}`}
                style={{ '--accent': brandAccent(slug, null) } as CSSProperties}
              >
                <span className={s.iconBadge}><Icon aria-hidden /></span>
                <p className={`hub-eyebrow ${s.perkTag}`}>
                  <span aria-hidden className={s.dot} />
                  {tag}
                </p>
                <h3 className={s.perkHead}>{head}</h3>
                <p className={s.perkBody}>{body}</p>
              </div>
            </RevealItem>
          ))}
        </RevealGroup>

        {/* Two routes, per the WhatsApp-marketing skill: the regulars' list is
            a WhatsApp-first asset (the dominant channel in PK; broadcasts beat
            email open rates 4-5x). Web signup stays as the backup so guests
            who don't want WhatsApp aren't shut out. */}
        <Reveal className={s.insiderCtas}>
          <a
            href={whatsappLink(BRAND_LOCATIONS['simmer']!, 'add me to servd insiders')}
            target="_blank"
            rel="noopener noreferrer"
            className={`hub-btn ${s.whatsappBtn}`}
            aria-label="Join on WhatsApp (opens in a new tab)"
          >
            <MessageCircle aria-hidden /> Join on WhatsApp
          </a>
          <Link href="/signup?insider=1" className="hub-btn-ghost">
            <Mail aria-hidden /> Or sign up with email
          </Link>
          <Link href="/login" className={s.signinLink}>
            Already a member? Sign in
          </Link>
          <span className="hub-meta">Free forever · cancel anytime</span>
        </Reveal>
      </div>
    </section>
  )
}
