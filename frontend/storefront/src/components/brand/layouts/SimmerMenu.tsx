// SimmerMenu — placeholder menu surface for /brand/simmer/menu.
// Renders the printed-card aesthetic of the brand microsite while
// real menu data is still in flight: forest green ink-on-paper feel
// inverted to bone-on-green, Amarante for the dish names + section
// rubrics, Times for prices and notes, single orange signal on the
// service date. Marked as `pending kitchen` so anyone scanning the
// QR in the room knows this is a draft.
//
// When the operator publishes a real menu (`/api/v1/storefront/<slug>/menu`
// returns categories), the menu page will render the live categories
// through the generic table-style layout instead of this placeholder.

import Link from 'next/link'

// Today's date in the menu's signature `26.05.26` format.
function todayStamp(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${dd}.${mm}.${yy}`
}

interface PlaceholderItem {
  name: string
  body: string
  pricePkr: number
}
interface PlaceholderCourse {
  rubric: string
  title: string
  items: PlaceholderItem[]
}

// Placeholder courses — operator can replace any item via the API.
// Copy intentionally dry: ingredient list, no banned words (no
// "crafted", "elevated", "experience", "journey", "passionate",
// "artisanal", "fusion", "twist on a classic"). No exclamation marks.
const PLACEHOLDER_MENU: PlaceholderCourse[] = [
  {
    rubric: 'I.',
    title: 'small plates',
    items: [
      { name: 'Burrata',         body: 'blistered tomato · olive oil cracker · basil',  pricePkr: 1400 },
      { name: 'Charred octopus', body: 'smoked aioli · pickled chilli · lemon',         pricePkr: 1650 },
      { name: 'Beef tartare',    body: 'capers · cured yolk · sourdough crisp',         pricePkr: 1750 },
    ],
  },
  {
    rubric: 'II.',
    title: 'large plates',
    items: [
      { name: 'Lamb shoulder',         body: 'soft polenta · jus · gremolata',           pricePkr: 2800 },
      { name: 'Hand-cut tagliatelle',  body: 'brown butter · sage · aged parmesan',      pricePkr: 2200 },
      { name: 'Seared duck breast',    body: 'charred plum · turnip · five-spice jus',   pricePkr: 2950 },
    ],
  },
  {
    rubric: 'III.',
    title: 'desserts',
    items: [
      { name: 'Olive oil chocolate cake', body: 'maldon flake · whipped crème fraîche',  pricePkr:  950 },
      { name: 'Cardamom panna cotta',     body: 'roasted apricot · honeycomb shard',     pricePkr:  900 },
      { name: 'Bone marrow caramel',      body: 'salted caramel · burnt-butter ice',     pricePkr: 1050 },
    ],
  },
  {
    rubric: 'IV.',
    title: 'mocktails',
    items: [
      { name: 'Garden Spritz',         body: 'basil · lime · cucumber · house soda',       pricePkr:  850 },
      { name: 'Negroni, sin',          body: 'non-alc bitters · blood orange · oleo',      pricePkr:  950 },
      { name: 'Smoked Old Fashioned',  body: 'smoked cherry · char · sugar · non-alc',     pricePkr:  950 },
    ],
  },
]

export function SimmerMenu({ slug, conceptName }: { slug: string, conceptName: string }) {
  const stamp = todayStamp()
  const fmt = (pkr: number) => `Rs ${pkr.toLocaleString('en-PK')}`

  return (
    <div className="simmer-page" style={{ minHeight: '100vh' }}>

      {/* ── MASTHEAD — printed-menu header ─────────────────────────── */}
      <section style={{
        padding: 'clamp(2.5rem, 6vh, 4rem) clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 4vh, 2.5rem)',
      }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            paddingBottom: '0.9rem',
            borderBottom: '1px solid rgba(237,230,211,0.22)',
          }}>
            <span className="utility" style={{ fontSize: '0.72rem' }}>tonight&apos;s service</span>
            <span className="utility signal" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>{stamp}</span>
          </div>

          <div style={{ textAlign: 'center', padding: '2.4rem 0 0.6rem' }}>
            <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1rem' }}>
              the menu
            </p>
            <p className="wordmark amarante" style={{
              fontSize: 'clamp(2.6rem, 8vw, 4.2rem)', lineHeight: 1, margin: 0,
            }}>
              simmer down<span className="signal">.</span>
            </p>
            <p className="utility" style={{
              fontSize: '0.66rem', opacity: 0.55, marginTop: '1.4rem',
              letterSpacing: '0.4em',
            }}>
              draft — pending kitchen
            </p>
          </div>
        </div>
      </section>

      {/* ── COURSES ────────────────────────────────────────────────── */}
      <section style={{
        padding: '0 clamp(1.5rem, 5vw, 3rem) clamp(3rem, 8vh, 5rem)',
      }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          {PLACEHOLDER_MENU.map((course, ci) => (
            <div key={course.title} style={{
              padding: '2.2rem 0',
              borderTop: ci === 0 ? '1px solid rgba(237,230,211,0.22)' : '0',
              borderBottom: '1px solid rgba(237,230,211,0.18)',
            }}>
              {/* Course header — Amarante numeral + lowercase rubric */}
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: '0.9rem',
                marginBottom: '1.4rem',
              }}>
                <span className="amarante signal" style={{
                  fontSize: '1.5rem', lineHeight: 1,
                }}>{course.rubric}</span>
                <span className="utility" style={{
                  fontSize: '0.72rem', opacity: 0.72,
                }}>{course.title}</span>
              </div>

              {/* Items — name + body line, price right-aligned */}
              <div style={{ display: 'grid', gap: '1.2rem' }}>
                {course.items.map((item) => (
                  <div key={item.name} style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: '1rem',
                    alignItems: 'baseline',
                  }}>
                    <div>
                      <p className="amarante" style={{
                        fontSize: '1.2rem', lineHeight: 1.2, margin: '0 0 0.25rem',
                      }}>
                        {item.name}
                      </p>
                      <p style={{
                        fontFamily: 'var(--simmer-body)',
                        fontSize: '0.86rem',
                        lineHeight: 1.45,
                        letterSpacing: '0.02em',
                        opacity: 0.78,
                        margin: 0,
                      }}>
                        {item.body}
                      </p>
                    </div>
                    <p className="amarante" style={{
                      fontSize: '1rem',
                      letterSpacing: '0.04em',
                      opacity: 0.88,
                      whiteSpace: 'nowrap',
                      margin: 0,
                    }}>
                      {fmt(item.pricePkr)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── FOOTER NOTES + CTA ─────────────────────────────────────── */}
      <section style={{
        padding: 'clamp(3rem, 7vh, 5rem) clamp(1.5rem, 5vw, 3rem) clamp(4rem, 10vh, 6rem)',
        textAlign: 'center',
      }}>
        <div style={{ maxWidth: '32rem', margin: '0 auto' }}>
          <p className="utility" style={{ fontSize: '0.66rem', opacity: 0.55, letterSpacing: '0.4em' }}>
            menu changes when the kitchen changes
          </p>
          <p className="amarante" style={{
            fontSize: 'clamp(1.4rem, 4vw, 2rem)', lineHeight: 1.25, margin: '1.4rem 0 0',
          }}>
            ready to order from your table?
          </p>
          <p style={{
            fontFamily: 'var(--simmer-body)',
            fontSize: '0.95rem', letterSpacing: '0.02em',
            opacity: 0.78, marginTop: '0.8rem',
          }}>
            Tap below — your seat number is on the card at your setting.
          </p>
          <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href={`/${slug}`} className="action action--signal">order at the table</Link>
            <Link href={`/brand/${slug}`} className="action">{conceptName.toLowerCase()} home</Link>
          </div>
        </div>
      </section>

    </div>
  )
}
