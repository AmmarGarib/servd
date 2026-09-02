// Hand-drawn line-art dish glyphs — the shared icon set for the cursor's
// scroll morph and the scroll dock. Stroke-based (currentColor) so they
// render in any ink, including mix-blend-difference white. SVG only —
// never emoji (storefront rule).

import type { ReactNode } from 'react'

const G = (children: ReactNode) => children

// Each glyph draws inside a 24x24 box, stroke width 1.8, round caps.
export const FOOD_GLYPHS: { name: string; art: ReactNode }[] = [
  {
    name: 'burger',
    art: G(<>
      <path d="M4 10a8 5.5 0 0 1 16 0z" />
      <path d="M3.5 13h17" />
      <path d="M5 16.5h14a1.8 1.8 0 0 1-1.8 2.5H6.8A1.8 1.8 0 0 1 5 16.5z" />
      <line x1="9" y1="7.5" x2="9" y2="7.6" />
      <line x1="13" y1="6.8" x2="13" y2="6.9" />
    </>),
  },
  {
    name: 'fries',
    art: G(<>
      <path d="M7 10 6 4.5" /><path d="M10.2 9.5 10 3.8" /><path d="M13.6 9.5 14 4.2" /><path d="M17 10 18 5.4" />
      <path d="M5.5 10h13l-1.6 9.5H7.1z" />
    </>),
  },
  {
    name: 'pizza',
    art: G(<>
      <path d="M12 21 4.5 6a15 15 0 0 1 15 0z" />
      <circle cx="11" cy="10" r="1" /><circle cx="14.5" cy="13" r="1" /><circle cx="10.5" cy="15.5" r="1" />
    </>),
  },
  {
    name: 'drink',
    art: G(<>
      <path d="M7 8h10l-1.4 12H8.4z" />
      <path d="M6.5 8 17.5 8" /><path d="M12 8 15 3" />
    </>),
  },
  {
    name: 'coffee',
    art: G(<>
      <path d="M5 10h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" />
      <path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8.5 7c0-1 .8-1 .8-2" /><path d="M12 7c0-1 .8-1 .8-2" />
    </>),
  },
  {
    name: 'icecream',
    art: G(<>
      <path d="M7.5 11h9L12 21.5z" />
      <path d="M7.3 11a4.8 4.8 0 1 1 9.4 0" />
    </>),
  },
  {
    name: 'donut',
    art: G(<>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M7 9.5 8.4 9" /><path d="M15.6 7.6l1 .9" /><path d="M16 16l1.3-.4" /><path d="M8 15.4l.8 1" />
    </>),
  },
  {
    name: 'drumstick',
    art: G(<>
      <path d="M15.5 3.5a5 5 0 0 1 3.2 8.5c-1.7 1.8-4.6 2.4-6.6 2.7l-3.4 3.5a2 2 0 1 1-3-2.9l3.5-3.4c.3-2 .9-4.9 2.7-6.6a5 5 0 0 1 3.6-1.8z" />
    </>),
  },
  {
    name: 'hotdog',
    art: G(<>
      <path d="M4 13.5c5-4.5 11-4.5 16 0" />
      <path d="M4 10.5c5-4.5 11-4.5 16 0" transform="translate(0 6)" />
      <path d="M6 12.7c4-3 8-3 12 0" />
    </>),
  },
  {
    name: 'taco',
    art: G(<>
      <path d="M3.5 17a8.5 8.5 0 0 1 17 0z" />
      <path d="M6.5 13.5c.8-.9 1.8-.9 2.6 0s1.8.9 2.6 0 1.8-.9 2.6 0 1.8.9 2.6 0" />
    </>),
  },
  {
    name: 'bowl',
    art: G(<>
      <path d="M4 11h16a8 8 0 0 1-16 0z" />
      <path d="M9.5 8c0-1 .8-1 .8-2" /><path d="M13.5 8c0-1 .8-1 .8-2" />
    </>),
  },
  {
    name: 'croissant',
    art: G(<>
      <path d="M12 7c3.5 0 7.5 2.8 8.5 6.5-1.2 1-2.6 1.5-4 1.3C15.6 12.2 14 11 12 11s-3.6 1.2-4.5 3.8c-1.4.2-2.8-.3-4-1.3C4.5 9.8 8.5 7 12 7z" />
      <path d="M7.5 14.8 6 17" /><path d="M16.5 14.8 18 17" />
    </>),
  },
]

export function FoodGlyph({ index, size = 26, strokeWidth = 1.8 }: {
  index: number; size?: number; strokeWidth?: number
}) {
  const glyph = FOOD_GLYPHS[((index % FOOD_GLYPHS.length) + FOOD_GLYPHS.length) % FOOD_GLYPHS.length]!
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      {glyph.art}
    </svg>
  )
}
