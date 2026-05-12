'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'
import { OpenStatusBadge, useHoursData } from '../parts/OpenStatusBadge'

// Strata — premium chef-driven performance kitchen. Clean white + deep mint.
// The goal-filter stays — but framed as "tonight's brief", not a gym tracker.
// Macro chips are secondary to great food. Chef credibility leads.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const STRATA_MINT      = '#2D6A4F'
const STRATA_MINT_SOFT = '#d8f3dc'
const STRATA_INK       = '#0c1e16'

type Goal = 'CUT' | 'BULK' | 'MAINTAIN'
interface Macro { p: number; c: number; f: number; kcal: number }

const MEALS: Array<{ name: string; goal: Goal; price: number; macros: Macro; body: string; note: string; img: string }> = [
  { name: 'Performance Bowl',    goal: 'MAINTAIN', price: 1100, macros: { p: 45, c: 58, f: 14, kcal: 600 }, body: 'Quinoa cooked in herb broth, pulled grilled chicken, roasted courgette and capsicum, tahini dressing made in-house. The dish regulars reorder without looking at the menu.',                        note: 'Running on the menu since day one.',           img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=85' },
  { name: 'Protein Stack Bowl',  goal: 'BULK',     price: 1250, macros: { p: 52, c: 64, f: 18, kcal: 700 }, body: 'Lean beef mince, cumin-roasted sweet potato, half an avocado sliced fresh to order, brown rice. Dense and filling — the macros explain why it works.',                                             note: 'The one regulars order on strength days.',     img: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=600&q=85' },
  { name: 'Rebuild Bowl',        goal: 'BULK',     price: 1300, macros: { p: 58, c: 72, f: 20, kcal: 760 }, body: 'Spiced chicken thigh, slow-cooked lentils, roasted root veg, bone broth poured at plating. The kitchen\'s highest-protein build — designed for the 24 hours after you push hard.',               note: 'Our heaviest build. Earn it first.',            img: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=85' },
  { name: 'Cut-Day Bowl',        goal: 'CUT',      price: 950,  macros: { p: 42, c: 22, f: 9,  kcal: 380 }, body: 'Grilled chicken breast, shaved red cabbage, cherry tomatoes, cucumber, lemon-herb dressing. Under 400 kcal — you\'ll be surprised how full you are.',                                            note: 'People are always surprised how satisfying this is.', img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=85' },
  { name: 'Endurance Plate',     goal: 'MAINTAIN', price: 1150, macros: { p: 36, c: 80, f: 12, kcal: 620 }, body: 'Chicken thigh braised until tender, jasmine rice, sesame and ginger slaw. Carb-forward by design — built for the night before a long effort, or the morning after.',                              note: 'Order this the night before something long.',   img: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=85' },
  { name: 'Power Wrap',          goal: 'CUT',      price: 850,  macros: { p: 38, c: 32, f: 11, kcal: 460 }, body: 'Scrambled egg whites, sautéed spinach, hummus, house-made pickled onion, folded into a warm whole-wheat wrap. High protein, genuinely light, works as a lunch or a post-session meal.',          note: 'Fastest prep. Best for a clean, quick lunch.',  img: 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=600&q=85' },
]

const goalTint = (goal: Goal): string => {
  if (goal === 'CUT')   return '#0ea5e9'
  if (goal === 'BULK')  return '#f59e0b'
  return STRATA_MINT
}

const GOAL_LABELS: Record<Goal, { label: string; sub: string }> = {
  'CUT':      { label: 'Lighter',   sub: 'Lean days, high protein' },
  'MAINTAIN': { label: 'Balanced',  sub: 'Everyday performance' },
  'BULK':     { label: 'Build',     sub: 'Max calories, max protein' },
}

export function StrataLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  return (
    <div style={{ background: '#fff', color: STRATA_INK }}>
      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={STRATA_MINT} />

      {/* HERO — chef-first. Numbers are the proof, not the pitch. */}
      <section style={{
        position: 'relative',
        padding: 'clamp(3.5rem, 7vw, 5.5rem) 0 clamp(3rem, 6vw, 4.5rem)',
        background: STRATA_MINT_SOFT,
        borderBottom: `1px solid ${STRATA_MINT}33`,
      }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '3rem', alignItems: 'center' }}>

            <div>
              <p style={{ color: STRATA_MINT, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                Chef-driven · performance kitchen
              </p>
              <h1 style={{
                fontSize: 'clamp(2.75rem, 7.5vw, 5rem)',
                fontWeight: 800,
                letterSpacing: '-0.04em',
                lineHeight: 0.98,
                margin: 0,
                color: STRATA_INK,
              }}>
                Cooked right.<br />
                <span style={{ color: STRATA_MINT }}>Built for you.</span>
              </h1>
              <div style={{ marginTop: '1rem' }}>
                <OpenStatusBadge hoursData={hoursData} accentColor={STRATA_MINT} />
              </div>
              <p style={{ marginTop: '1.75rem', fontSize: '1.1rem', color: `${STRATA_INK}99`, lineHeight: 1.6, maxWidth: '34rem' }}>
                {concept.name} is a chef-run performance kitchen — high-protein, clean-label cooking that doesn&rsquo;t compromise on flavour. Every dish is engineered to hit your goal without tasting like it tried.
              </p>
              <div style={{ marginTop: '2.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Link href={`/${concept.slug}`} style={{
                  padding: '1rem 2rem',
                  background: STRATA_MINT, color: 'white',
                  fontWeight: 700, fontSize: '0.95rem',
                  textDecoration: 'none', borderRadius: '0.5rem',
                  letterSpacing: '0.02em',
                }}>
                  Order now →
                </Link>
                <Link href={`/brand/${concept.slug}/menu`} style={{
                  padding: '1rem 2rem',
                  background: 'white', color: STRATA_INK,
                  fontWeight: 600, fontSize: '0.95rem',
                  textDecoration: 'none', borderRadius: '0.5rem',
                  border: `1px solid ${STRATA_INK}1a`,
                }}>
                  Browse menu
                </Link>
              </div>
            </div>

            {/* Hero food image — the food is the product */}
            <div style={{
              borderRadius: '1rem',
              overflow: 'hidden',
              boxShadow: `0 12px 40px ${STRATA_MINT}2a`,
              position: 'relative',
              minHeight: '360px',
            }}>
              <img
                src="https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=900&q=85"
                alt="Performance bowl — grilled chicken, quinoa, tahini"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', minHeight: '360px' }}
              />
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: `linear-gradient(transparent, ${STRATA_INK}cc)`,
                padding: '2rem 1.5rem 1.5rem',
              }}>
                <p style={{ fontSize: '0.68rem', fontWeight: 700, color: STRATA_MINT_SOFT, letterSpacing: '0.22em', textTransform: 'uppercase', marginBottom: '0.3rem' }}>
                  Chef&rsquo;s most-ordered
                </p>
                <p style={{ fontSize: '1.1rem', fontWeight: 800, color: 'white' }}>Performance Bowl — Rs. 1,100</p>
                <p style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.7)', marginTop: '0.2rem' }}>45g protein · 600 kcal · macros on the label</p>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* TONIGHT'S BRIEF — the goal filter, framed as cooking context not gym stat */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0', borderBottom: `1px solid ${STRATA_INK}14` }}>
        <div className="container">

          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '2.5rem' }}>
            <div>
              <p style={{ color: STRATA_MINT, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Tonight&rsquo;s brief
              </p>
              <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.05 }}>
                What are you building today?
              </h2>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {(['CUT', 'MAINTAIN', 'BULK'] as const).map((g) => (
                <div key={g} style={{
                  padding: '0.55rem 1rem',
                  background: `${goalTint(g)}0f`,
                  border: `1px solid ${goalTint(g)}44`,
                  borderRadius: '999px',
                }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 800, color: goalTint(g), letterSpacing: '0.14em' }}>
                    {GOAL_LABELS[g].label}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: `${STRATA_INK}66`, marginLeft: '0.4rem' }}>
                    — {GOAL_LABELS[g].sub}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '1.25rem' }}>
            {MEALS.map((m) => {
              const tint = goalTint(m.goal)
              return (
                <Link key={m.name} href={`/${concept.slug}`} style={{
                  display: 'flex', flexDirection: 'column',
                  background: 'white', border: `1px solid ${STRATA_INK}14`,
                  borderRadius: '0.85rem', overflow: 'hidden',
                  textDecoration: 'none', color: 'inherit',
                }}>
                  <div style={{ aspectRatio: '16/9', overflow: 'hidden' }}>
                    <img src={m.img} alt={m.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </div>
                  <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem' }}>
                    <span style={{
                      fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.18em',
                      color: tint, padding: '0.2rem 0.55rem',
                      border: `1px solid ${tint}44`, borderRadius: '4px',
                    }}>
                      {GOAL_LABELS[m.goal].label.toUpperCase()}
                    </span>
                    <span style={{ fontSize: '1rem', fontWeight: 800, color: STRATA_INK }}>Rs. {m.price.toLocaleString()}</span>
                  </div>
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 800, letterSpacing: '-0.01em', marginBottom: '0.3rem' }}>{m.name}</h3>
                  <p style={{ fontSize: '0.88rem', color: `${STRATA_INK}88`, lineHeight: 1.45, marginBottom: '0.4rem' }}>{m.body}</p>
                  <p style={{ fontSize: '0.78rem', color: tint, fontStyle: 'italic', marginBottom: '1rem' }}>{m.note}</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.4rem', marginTop: 'auto' }}>
                    <MacroChip label="P"    value={`${m.macros.p}g`}    tint={STRATA_MINT} />
                    <MacroChip label="C"    value={`${m.macros.c}g`}    tint="#0ea5e9" />
                    <MacroChip label="F"    value={`${m.macros.f}g`}    tint="#f59e0b" />
                    <MacroChip label="kcal" value={`${m.macros.kcal}`}  tint={STRATA_INK} />
                  </div>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      </section>

      {/* THE KITCHEN — chef story, credibility, process */}
      <section style={{ padding: 'clamp(3.5rem, 7vw, 6rem) 0', background: STRATA_INK, color: 'white' }}>
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '3rem', alignItems: 'center' }}>
          <div>
            <p style={{ color: STRATA_MINT_SOFT, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              The kitchen
            </p>
            <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              The numbers are<br /><span style={{ color: STRATA_MINT_SOFT }}>the side effect.</span>
            </h2>
            <p style={{ marginTop: '1.25rem', fontSize: '1rem', color: 'rgba(255,255,255,0.7)', lineHeight: 1.7 }}>
              Every dish starts in the kitchen, not a spreadsheet. We write the recipe for flavour first — the macros follow from good ingredients, proper technique, and portions that aren&rsquo;t a punishment.
            </p>
            <p style={{ marginTop: '1rem', fontSize: '1rem', color: 'rgba(255,255,255,0.55)', lineHeight: 1.6, fontStyle: 'italic' }}>
              Cooked in our ghost kitchen. Delivered to your door. Published macros on every item — not because we&rsquo;re a tracker, but because transparency is the point.
            </p>
            <Link href={`/${concept.slug}`} style={{
              display: 'inline-block', marginTop: '1.75rem',
              padding: '0.9rem 1.75rem',
              background: STRATA_MINT_SOFT, color: STRATA_INK,
              fontWeight: 800, fontSize: '0.9rem',
              textDecoration: 'none', borderRadius: '0.5rem',
              letterSpacing: '0.02em',
            }}>
              Start an order →
            </Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {[
              { heading: 'Clean labels only',     body: 'No seed oils, no hidden sugars, no filler protein. Every ingredient is something you can name.' },
              { heading: 'Proper portions',        body: 'Not gym-counter scoops. Real food, real volume — engineered so you hit the goal without feeling like you lost the meal.' },
              { heading: 'Cooked to order',        body: 'Nothing sits under a heat lamp. Your order goes in when the kitchen receives it.' },
            ].map((c) => (
              <div key={c.heading} style={{
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${STRATA_MINT}55`,
                borderRadius: '0.75rem',
                padding: '1.25rem 1.5rem',
              }}>
                <p style={{ fontWeight: 700, fontSize: '1rem', color: STRATA_MINT_SOFT, marginBottom: '0.4rem' }}>{c.heading}</p>
                <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.55 }}>{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WEEKLY PLAN */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0', borderBottom: `1px solid ${STRATA_INK}14` }}>
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '2rem', alignItems: 'center' }}>
          <div>
            <p style={{ color: STRATA_MINT, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              5-meal plan
            </p>
            <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              The whole week.<br />Cooked. Counted. <span style={{ color: STRATA_MINT }}>Done.</span>
            </h2>
            <p style={{ marginTop: '1.25rem', fontSize: '1rem', color: `${STRATA_INK}88`, lineHeight: 1.6 }}>
              Subscribe to a 5-meal weekly plan matched to your goal. We cook, portion, and deliver. Pause anytime.
            </p>
            <Link href={`/${concept.slug}`} style={{
              display: 'inline-block', marginTop: '1.5rem',
              padding: '0.9rem 1.75rem',
              background: STRATA_MINT, color: 'white',
              fontWeight: 800, fontSize: '0.9rem',
              textDecoration: 'none', borderRadius: '0.5rem',
            }}>
              Build my plan →
            </Link>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
            {[
              { label: 'Lighter',  kcal: 1850, protein: 175, color: '#0ea5e9', dishes: ['Cut-Day Bowl', 'Power Wrap', 'Endurance Plate'] },
              { label: 'Balanced', kcal: 2300, protein: 195, color: STRATA_MINT, dishes: ['Performance Bowl', 'Endurance Plate', 'Protein Stack Bowl'] },
              { label: 'Build',    kcal: 2800, protein: 220, color: '#f59e0b', dishes: ['Rebuild Bowl', 'Protein Stack Bowl', 'Performance Bowl'] },
            ].map((p) => (
              <div key={p.label} style={{
                background: `${p.color}0a`,
                border: `1px solid ${p.color}44`,
                borderRadius: '0.75rem',
                padding: '1.25rem',
              }}>
                <p style={{ fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.18em', color: p.color, marginBottom: '0.5rem', textTransform: 'uppercase' }}>{p.label}</p>
                <p style={{ fontSize: '1.65rem', fontWeight: 900, color: STRATA_INK, letterSpacing: '-0.02em' }}>{p.kcal}</p>
                <p style={{ fontSize: '0.72rem', color: `${STRATA_INK}66`, letterSpacing: '0.06em' }}>kcal/day · {p.protein}g protein</p>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {p.dishes.map((d) => (
                    <li key={d} style={{ fontSize: '0.78rem', color: `${STRATA_INK}88`, display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
                      <span style={{ color: p.color, fontWeight: 700 }}>—</span>{d}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CrossBrandStrip current={concept} concepts={concepts} accent={STRATA_MINT} kicker="Cheat day?" heading="When you're not counting — try one of these." />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={STRATA_MINT} />
    </div>
  )
}

function MacroChip({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div style={{
      background: `${tint}0e`,
      border: `1px solid ${tint}2a`,
      borderRadius: '0.4rem',
      padding: '0.4rem 0.4rem',
      textAlign: 'center',
    }}>
      <p style={{ fontSize: '0.6rem', fontWeight: 700, color: tint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</p>
      <p style={{ fontSize: '0.82rem', fontWeight: 800, color: STRATA_INK, marginTop: '0.1rem' }}>{value}</p>
    </div>
  )
}
