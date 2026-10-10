// Every section renderer, keyed by variant.
//
// Every page that renders sections imports this map, so whatever it imports
// statically ships with every such page. Each group therefore splits its
// renderers in two:
//   - SERVER sections (no 'use client') are static imports in
//     <group>/renderers.tsx. They never reach the browser.
//   - CLIENT sections ('use client') are next/dynamic components declared in
//     <group>/lazy.ts, so a page downloads only the sections it renders. SSR
//     is kept, so the server HTML is unchanged.
// The dynamic() calls must sit in a 'use client' module. Next 14 bundles every
// client component it can reach from the server graph (a static or a dynamic
// import) into the page's first-load JS, so dynamic() in a server file splits
// nothing. A new client section goes in <group>/lazy.ts, never as a static
// import in renderers.tsx.

import type { SectionComponent } from './types'
import { renderers as servd } from './servd/renderers'
import { renderers as brand } from './brand/renderers'
import { renderers as stackd } from './stackd/renderers'
import { renderers as simmer } from './simmer/renderers'
import { renderers as flipd } from './flipd/renderers'

export const SECTION_RENDERERS: Record<string, SectionComponent> = {
  ...servd, ...brand, ...stackd, ...simmer, ...flipd,
}
