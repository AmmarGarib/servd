// stackd sections — catalogue (data only: no React, no imports from renderers).
// See ../README.md for the contract.
//
// The Stackd microsite home (stackd.pk / servd.pk/brand/stackd), broken out of
// the old components/brand/layouts/StackdLayout.tsx. Stackd is a 20-seat
// scratch-cooking café with a small market at the counter — sandwiches,
// pastries, light bites, craft mocktails. NOT burgers. Packaging is the
// service vessel; cards are stickers, never rectangles; no grid anywhere.
//
// Text fields accept {{brand.name}} (the live brand name). Brand data — name,
// address, phone, email, hours, open/closed, reservations on/off, uploaded
// wordmark and mascot — stays live; an override field left empty uses it.
//
// Links take the shared brand tokens (resolved by ../brand/util brandHref):
// @menu, @order, @book … follow the host — /menu on stackd.pk and
// /brand/stackd/menu on servd, and servd pages (ordering, booking, /home)
// absolute on servd's origin from stackd.pk — so the brand domain never links
// to a second copy of a page.
import type { PageDefault, SectionSpec } from '../types'

const PAGES = ['brand:stackd']
const GROUP = 'Stackd'
const BRAND_HINT = '{{brand.name}} = the live brand name'
const LINK_HINT = 'Link tokens: @home @menu @about @visitpage @order @book @location. {{brand.name}} works in the label.'

export const specs: SectionSpec[] = [
  {
    variant: 'stackd.slip',
    label: 'Stackd slip hero',
    group: GROUP,
    description: 'The mascot slips and the bread goes flying as you scroll, then the payoff line and buttons.',
    icon: 'SL',
    pages: PAGES,
    summaryKey: 'line',
    fields: [
      { key: 'hint', label: 'Scroll cue', kind: 'text', hint: 'Shown at the top before the fall. Empty = none' },
      { key: 'line', label: 'Payoff line', kind: 'text', hint: BRAND_HINT },
      { key: 'subLead', label: 'Payoff sub-line (lead)', kind: 'text', hint: 'The counter lines follow it, joined with commas' },
      {
        key: 'counterLines', label: 'What the counter puts out', kind: 'list', itemLabel: 'Line', max: 10,
        item: [{ key: 'text', label: 'Line', kind: 'text' }],
      },
      { key: 'orderCta', label: 'Order button', kind: 'link', hint: LINK_HINT },
      { key: 'menuCta', label: 'Menu button', kind: 'link', hint: LINK_HINT },
      { key: 'mascotAlt', label: 'Mascot description (alt text)', kind: 'text', hint: 'For the bundled two-piece drawing' },
      { key: 'breadImage', label: 'Bread piece (top half)', kind: 'image', hint: 'The stack that flies off the tray. Empty = bundled artwork' },
      { key: 'guyImage', label: 'Mascot piece (bottom half)', kind: 'image', hint: 'Tray, hands, trousers, shoes. Empty = bundled artwork' },
      {
        key: 'customMascot', label: 'Whole mascot (replaces the slip)', kind: 'image',
        hint: 'Empty = the mascot uploaded in admin → Brands; with none there either, the two pieces above do the slip. A whole drawing is shown still.',
      },
      { key: 'customMascotAlt', label: 'Whole mascot alt text', kind: 'text', hint: BRAND_HINT },
    ],
    defaults: {
      hint: 'Scroll',
      line: 'we’ll make another.',
      subLead: 'everything here is cut, baked and built on site —',
      counterLines: [
        { text: 'sandwiches.' },
        { text: 'pastries.' },
        { text: 'light bites.' },
        { text: 'craft mocktails.' },
        { text: 'grab & go.' },
      ],
      orderCta: { text: 'Order {{brand.name}}', href: '@order' },
      menuCta: { text: 'See the menu', href: '@menu' },
      mascotAlt: 'The Stackd character — a stack of bread slices carried on a plum tray, striped trousers below',
      breadImage: '/brand/stackd/bread.png',
      guyImage: '/brand/stackd/guy.png',
      customMascot: '',
      customMascotAlt: '{{brand.name}} brand character',
    },
  },
  {
    variant: 'stackd.hero',
    label: 'Stackd wordmark hero',
    group: GROUP,
    description: 'The wordmark lockup, tagline, one-liner and the order/menu buttons.',
    icon: 'WH',
    pages: PAGES,
    summaryKey: 'tagline',
    fields: [
      { key: 'specLeft', label: 'Top-left label', kind: 'text' },
      { key: 'specRight', label: 'Top-right label', kind: 'text' },
      {
        key: 'headingText', label: 'Page heading (hidden text)', kind: 'text',
        hint: `The page's one h1 — say what and where. Read by search engines and screen readers; the wordmark image shows instead. ${BRAND_HINT}`,
      },
      { key: 'wordmark', label: 'Wordmark image', kind: 'image', hint: 'Empty = the wordmark uploaded in admin → Brands, else the bundled lockup' },
      { key: 'lineColor', label: 'Short rule colour', kind: 'color', hint: 'Empty = cream' },
      { key: 'tagline', label: 'Tagline', kind: 'text', hint: BRAND_HINT },
      { key: 'body', label: 'One-liner', kind: 'textarea', rows: 3, hint: BRAND_HINT },
      { key: 'primaryCta', label: 'Primary button', kind: 'link', hint: LINK_HINT },
      { key: 'secondaryCta', label: 'Secondary button', kind: 'link', hint: LINK_HINT },
    ],
    defaults: {
      specLeft: 'Karachi',
      specRight: 'Café · market · scratch kitchen',
      headingText: '{{brand.name}} — scratch-cooking café and market, Karachi',
      wordmark: '',
      lineColor: '',
      tagline: 'Cooked here. Wrapped, not plated.',
      body: 'A twenty-seat scratch-cooking café and small market — sandwiches, pastries, light bites and craft mocktails.',
      primaryCta: { text: 'Order {{brand.name}}', href: '@order' },
      secondaryCta: { text: 'View menu', href: '@menu' },
    },
  },
  {
    variant: 'stackd.stickers',
    label: 'Stackd stickers',
    group: GROUP,
    description: 'Short lines, each on a die-cut seal set slightly off-square.',
    icon: 'ST',
    pages: PAGES,
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text', hint: BRAND_HINT },
      { key: 'spec', label: 'Side label', kind: 'text' },
      { key: 'numbered', label: 'Number the stickers (01, 02 …)', kind: 'toggle' },
      {
        key: 'items', label: 'Stickers', kind: 'list', itemLabel: 'Sticker', max: 12,
        item: [{ key: 'text', label: 'Text', kind: 'text' }],
      },
    ],
    defaults: {
      heading: 'What we do.',
      spec: 'The short version',
      numbered: true,
      items: [
        { text: 'Scratch cooking' },
        { text: 'Sandwiches & pastries' },
        { text: 'Craft mocktails' },
        { text: 'Grab-and-go market' },
      ],
    },
  },
  {
    variant: 'stackd.room',
    label: 'Stackd story seal',
    group: GROUP,
    description: 'The long story on one large cream seal.',
    icon: 'RM',
    pages: PAGES,
    summaryKey: 'heading',
    fields: [
      { key: 'spec', label: 'Label', kind: 'text' },
      { key: 'heading', label: 'Heading', kind: 'text', hint: BRAND_HINT },
      { key: 'body', label: 'Story', kind: 'textarea', rows: 6, hint: BRAND_HINT },
      { key: 'bg', label: 'Seal colour', kind: 'color', hint: 'Empty = brand cream' },
    ],
    defaults: {
      spec: 'The room',
      heading: 'Twenty seats, and a market.',
      body: 'Stackd is a scratch cooking café: sandwiches, pastries, light bites and craft mocktails, made here rather than assembled. Service is a deliberate choice — the food comes in packaging, not on plates. Not throwaway pieces, but a vessel built for the dish it carries and branded like everything else we make. Twenty seats, and a small market folded into the cashier and barista bar: a chiller for grab-and-go and drinks, and a case for the morning’s pastries.',
      bg: '',
    },
  },
  {
    variant: 'stackd.visit',
    label: 'Stackd hours & where',
    group: GROUP,
    description: 'Live opening hours and open/closed, the address, phone, email and the reserve button.',
    icon: 'HW',
    pages: PAGES,
    summaryKey: 'whereHeading',
    fields: [
      { key: 'hoursSpec', label: 'Hours label', kind: 'text' },
      { key: 'hoursHeading', label: 'Hours heading', kind: 'text' },
      { key: 'hoursEmpty', label: 'No hours published text', kind: 'text' },
      { key: 'whereSpec', label: 'Where label', kind: 'text' },
      { key: 'whereHeading', label: 'Where heading', kind: 'text' },
      { key: 'address', label: 'Address (override)', kind: 'textarea', rows: 2, hint: 'Empty = the live address from admin → Brands' },
      { key: 'addressMissing', label: 'Text when no address is set', kind: 'text' },
      { key: 'showPhone', label: 'Show phone', kind: 'toggle', hint: 'The live phone number' },
      { key: 'showEmail', label: 'Show email', kind: 'toggle', hint: 'The live guest email' },
      { key: 'reserveCta', label: 'Reserve button', kind: 'link', hint: `Shown only while reservations are on for the brand. Empty text = hidden. ${LINK_HINT}` },
    ],
    defaults: {
      hoursSpec: 'Hours',
      hoursHeading: 'When we’re on.',
      hoursEmpty: 'Hours not published yet.',
      whereSpec: 'Where',
      whereHeading: 'Find us.',
      address: '',
      addressMissing: 'Karachi · address TBA',
      showPhone: true,
      showEmail: true,
      reserveCta: { text: 'Reserve a table', href: '@book' },
    },
  },
  {
    variant: 'stackd.rule',
    label: 'Stackd hairline',
    group: GROUP,
    description: 'A thin full-width line.',
    icon: 'HR',
    pages: PAGES,
    fields: [
      { key: 'color', label: 'Line colour', kind: 'color', hint: 'Empty = faint cream' },
    ],
    defaults: { color: '' },
  },
  {
    variant: 'stackd.crossBrand',
    label: 'Stackd other brands strip',
    group: GROUP,
    description: 'Cards for the other brands from the same company (live).',
    icon: 'XB',
    pages: PAGES,
    summaryKey: 'heading',
    fields: [
      { key: 'kicker', label: 'Kicker', kind: 'text', hint: 'Empty = “Other GS Foods kitchens”' },
      { key: 'heading', label: 'Heading', kind: 'text', hint: `Empty = “Liked … ? Try one of these.” ${BRAND_HINT}` },
      { key: 'subtitle', label: 'Line under the heading', kind: 'textarea', rows: 2, hint: 'Empty hides it.' },
      { key: 'allLink', label: 'All-kitchens button', kind: 'link', hint: 'Empty label hides the button. A servd path (/home#kitchens) is absolute on servd from stackd.pk.' },
      { key: 'cardCta', label: 'Card button', kind: 'text', hint: '{name} = that kitchen, e.g. Visit {name} →' },
      { key: 'accent', label: 'Kicker colour', kind: 'color', hint: 'Empty = brand cream' },
    ],
    defaults: {
      kicker: 'Also from the same kitchen group',
      heading: 'Other lines coming out of the same kitchen group.',
      subtitle: 'Same operator, same standards. Different cuisine, different vibe — and you can pair them in one cart.',
      allLink: { text: 'See all kitchens →', href: '/home#kitchens' },
      cardCta: 'Visit {name} →',
      accent: '',
    },
  },
  {
    variant: 'stackd.signoff',
    label: 'Stackd sign-off',
    group: GROUP,
    description: 'The wordmark lockup again on the deepest plum, with the address under it.',
    icon: 'SO',
    pages: PAGES,
    summaryKey: 'headingText',
    fields: [
      // Key kept from when this was a hidden h2, so owners' edits carry over;
      // it is now the lockup image's alt text (not a heading: the hero's h1
      // already heads the page with the same lockup).
      {
        key: 'headingText', label: 'Wordmark description (alt text)', kind: 'text',
        hint: `What the lockup says, for Google and screen readers. Empty = decoration only. ${BRAND_HINT}`,
      },
      { key: 'wordmark', label: 'Wordmark image', kind: 'image', hint: 'Empty = the wordmark uploaded in admin → Brands, else the bundled lockup' },
      { key: 'address', label: 'Line under the wordmark (override)', kind: 'text', hint: 'Empty = the live address' },
      { key: 'addressMissing', label: 'Text when no address is set', kind: 'text' },
      { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = deep plum' },
      { key: 'fg', label: 'Text colour', kind: 'color', hint: 'Empty = cream' },
      { key: 'lineColor', label: 'Address colour', kind: 'color', hint: 'Empty = faint cream' },
    ],
    defaults: {
      headingText: '{{brand.name}} & servd',
      wordmark: '',
      address: '',
      addressMissing: 'Karachi',
      bg: '',
      fg: '',
      lineColor: '',
    },
  },
]

export const pages: PageDefault[] = [
  {
    slug: 'brand:stackd',
    sections: [
      { variant: 'stackd.slip' },
      { variant: 'stackd.hero' },
      { variant: 'stackd.stickers' },
      { variant: 'stackd.room' },
      { variant: 'stackd.visit' },
      { variant: 'stackd.rule' },
      { variant: 'stackd.crossBrand' },
      { variant: 'stackd.signoff' },
    ],
  },
]
