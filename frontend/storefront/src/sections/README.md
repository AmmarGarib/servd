# Storefront sections

Every storefront page is edited in **Admin → Storefront** (owner, 2026-10-07:
"every element in the storefront module, all pages, and I can add elements and
pages as needed"). A page is a list of blocks (`SiteLayout` row keyed by slug).
Bespoke designs are broken into **sections**: one block type, `section`, with

```json
{ "id": "…", "type": "section", "variant": "stackd.hero", "fields": { "headline": "…" } }
```

`variant` picks the renderer; `fields` hold every word, image, link and colour
in it. Fields are merged over the variant's `defaults`, so a block with no
`fields` renders today's content.

## Files

```
src/sections/
  types.ts           FieldSpec / SectionSpec / PageDefault / SectionContext — the contract
  catalog.ts         aggregates every group's catalogue (data only)
  renderers.ts       aggregates every group's renderers
  ManagedPage.tsx    route helper: live layout, else the page's default sections
  safe.ts            safeHref / safeSrc / str / link / list / color / lines
  <group>/catalog.ts     specs + page defaults (DATA ONLY — no React imports)
  <group>/renderers.tsx  { [variant]: Component }
  <group>/*.tsx          the section components
```

Groups: `servd` (servd.pk pages + nav + footer), `brand` (brand chrome —
header/footer — plus About/Visit/Menu and the generic layout for brands without
a bespoke design), `stackd`, `simmer`, `flipd`.

## Writing a section

1. **Spec** in `<group>/catalog.ts`:

```ts
{
  variant: 'stackd.mascotBand',            // '<group>.<camelName>' — stable, stored in JSON
  label: 'Stackd mascot band',
  group: 'Stackd',                          // palette heading
  icon: 'MB',
  pages: ['brand:stackd'],                  // where the palette offers it ('brand:*', 'servd:*', 'page:*', '*')
  summaryKey: 'headline',
  fields: [
    { key: 'headline', label: 'Headline', kind: 'text' },
    { key: 'body', label: 'Body', kind: 'textarea' },
    { key: 'image', label: 'Mascot image', kind: 'image' },
    { key: 'cta', label: 'Button', kind: 'link' },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = brand cream' },
    { key: 'items', label: 'Stickers', kind: 'list', itemLabel: 'Sticker', max: 8,
      item: [{ key: 'title', label: 'Title', kind: 'text' }, { key: 'img', label: 'Image', kind: 'image' }] },
  ],
  defaults: {                               // TODAY'S CONTENT, verbatim
    headline: 'He carries everything.',
    body: '…',
    image: '/brand/stackd-mascot.png',
    cta: { text: 'Order', href: '/stackd' },
    bg: '',
    items: [{ title: '…', img: '…' }],
  },
}
```

2. **Component** (server or `'use client'`), props `SectionProps`:

```tsx
'use client'
import type { SectionProps } from '../types'
import { safeHref, safeSrc, str, link, list, color } from '../safe'

export function MascotBand({ fields, ctx }: SectionProps) {
  const cta = link(fields.cta)
  return (
    <section style={{ background: color(fields.bg) ?? 'var(--stackd-cream)' }}>
      <h2>{str(fields.headline)}</h2>
      {safeSrc(fields.image) && <img src={safeSrc(fields.image)} alt="" />}
      {cta.text && <a href={safeHref(cta.href)}>{cta.text}</a>}
    </section>
  )
}
```

3. Register it in `<group>/renderers.tsx`: `'stackd.mascotBand': MascotBand`.

4. **Page defaults** in `<group>/catalog.ts` — the page as it looks today:

```ts
{ slug: 'brand:stackd', sections: [{ variant: 'stackd.hero' }, { variant: 'stackd.mascotBand' }, …] }
```

Exact slugs win over patterns (`brand:*:about`).

## Rules

- **Pixel-faithful.** With default fields the page must look and behave
  exactly as it does today. Port the markup, classes and styles; change only
  where hard-coded content becomes `fields.x`.
- **Everything user-visible is a field**: headings, body copy, eyebrows,
  button labels + links, images, videos, alt text, list items (cards,
  highlights, perks, nav links, socials), and the colours an owner would want
  to change. Repeated things are `list` fields. Interactive art (3D, canvas,
  drag) stays code, but its text and images are fields.
- **Live data stays live.** Brand name, description, address, hours, phone,
  email, menu items and open/closed come from `ctx.concept` / the API. A text
  field that overrides live data defaults to `''`, and `''` means "use the
  live value" — say so in the field `hint`.
- **Safety:** every href through `safeHref`, every src through `safeSrc`,
  every colour through `color()`. Never `dangerouslySetInnerHTML` with a field.
- **Links that leave a brand domain** (servd pages like /login, /orders,
  /home) must be absolute when `ctx.onBrandHost` — reuse the `servdHref`
  pattern from `components/brand/BrandShell.tsx`.
- **Brand rules still apply**: brand names through `formatBrandName()`;
  Simmer per its SKILL rules (lowercase wordmark only as a logo, `simmer
  down.` below the wordmark, single orange signal, no white, no gradients, no
  exclamation marks, no emoji); no emoji as icons anywhere (SVG/text);
  colours via tokens (`--servd-*`, `--stackd-*`, `--simmer-*`, `--flipd-*`).
- **CSS**: reuse the existing classes in `app/globals.css`. New CSS goes in
  `src/sections/<group>/<group>.css`, imported from one of the group's
  component files — never edit `globals.css` from a group.
- Catalogue files are **data only** (the admin downloads them as JSON):
  no functions, no React, no Dates.
