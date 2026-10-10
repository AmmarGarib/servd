// flipd sections — catalogue (data only: no React, no imports from renderers).
// See ../README.md for the contract.
//
// The Flipd microsite (brand:flipd) and its menu page (brand:flipd:menu),
// ported from components/brand/layouts/FlipdLayout.tsx + FlipdMenuPage.tsx.
// Defaults are the pages' copy as it stood, verbatim — including the brand
// book's own words (core values, the build sheet's spec lines), which must not
// be paraphrased. Brand book: "Not about padel: we happen to be there, we
// never borrow the court's identity."
//
// Links use the brand tokens (@home @menu @order @book …), which follow the
// host: /menu on flipd.pk and /brand/flipd/menu on servd.pk, and the ordering
// and booking pages always on servd. A path written out in full
// (/brand/flipd/menu) is rewritten the same way.
import type { PageDefault, SectionSpec } from '../types'

const GROUP = 'Flipd'
const HOME = ['brand:flipd']
const MENU = ['brand:flipd:menu']
const LINK_HINT = 'Link tokens: @home @menu @about @visitpage @order @book @location. They follow the host — /menu on flipd.pk, /brand/flipd/menu on servd.pk.'

export const specs: SectionSpec[] = [
  {
    variant: 'flipd.checker',
    label: 'Flipd checker band',
    group: GROUP,
    description: 'The navy/bone checker — the brand\'s signature edge, used as a rule between sections.',
    icon: 'CB',
    pages: [...HOME, ...MENU],
    fields: [
      { key: 'size', label: 'Square size (px)', kind: 'number', min: 10, max: 48, step: 1, hint: 'Height of the band and size of each checker square. 22 is the brand book\'s.' },
    ],
    defaults: { size: 22 },
  },
  {
    variant: 'flipd.specHero',
    label: 'Flipd build-sheet hero',
    group: GROUP,
    description: 'The burger built to its own spec: parts drop in on scroll with numbered callouts, then it lands and the buttons appear.',
    icon: 'BS',
    pages: HOME,
    summaryKey: 'tagline',
    fields: [
      { key: 'titleLeft', label: 'Title block — left', kind: 'text' },
      { key: 'titleRight', label: 'Title block — right', kind: 'text' },
      { key: 'mark', label: 'Wordmark text', kind: 'text', hint: 'Shown in the middle of the sheet before the build starts. Empty = the brand\'s live name.' },
      { key: 'headingText', label: 'Page heading (hidden text)', kind: 'text', hint: 'The page\'s main heading (h1) — read by search engines and screen readers, not shown. Say what Flipd is. Empty = the wordmark text.' },
      { key: 'tagline', label: 'Tagline (after the burger lands)', kind: 'text' },
      { key: 'primary', label: 'Order button', kind: 'link', hint: LINK_HINT },
      { key: 'secondary', label: 'Menu button', kind: 'link', hint: LINK_HINT },
      { key: 'hint', label: 'Scroll hint', kind: 'text' },
      { key: 'ariaLabel', label: 'Screen-reader label', kind: 'text', hint: 'Empty = "<brand> — how it is built".' },
      {
        key: 'parts', label: 'Parts (top to bottom, as drawn)', kind: 'list', itemLabel: 'Part', max: 5,
        item: [
          { key: 'no', label: 'Callout number', kind: 'text', hint: 'The build step — 01 is the bottom part, built first.' },
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'spec', label: 'Spec line', kind: 'text', hint: 'Plain-spoken: name the ingredient, skip the adjective.' },
          { key: 'image', label: 'Artwork', kind: 'image', hint: 'Navy line art on transparent, cut from the badge.' },
          { key: 'width', label: 'Width', kind: 'number', min: 0.3, max: 1, step: 0.001, hint: 'Fraction of the widest part (this image\'s pixel width ÷ the widest one\'s).' },
          { key: 'side', label: 'Callout side', kind: 'select', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] },
          { key: 'flip', label: 'Flips as it drops', kind: 'toggle', hint: 'Once, on one part — the patty.' },
        ],
      },
    ],
    defaults: {
      titleLeft: 'Build sheet',
      titleRight: 'Same, every time',
      mark: '',
      headingText: 'Flipd — smash and grilled burgers in Karachi',
      tagline: 'A gourmet burger joint that happens to be at a padel court.',
      primary: { text: 'Order now', href: '@order' },
      secondary: { text: 'See the menu', href: '@menu' },
      hint: 'Scroll to build it',
      ariaLabel: '',
      parts: [
        { no: '05', name: 'Crown', spec: 'Brioche.',                       image: '/brand/parts/crown.png',   width: 0.884, side: 'left',  flip: false },
        { no: '04', name: 'Jam',   spec: 'Shroom & onion. House made.',    image: '/brand/parts/lettuce.png', width: 0.957, side: 'right', flip: false },
        { no: '03', name: 'Aioli', spec: 'Chimichurri. Roasted garlic.',   image: '/brand/parts/wing.png',    width: 1.000, side: 'left',  flip: false },
        { no: '02', name: 'Patty', spec: 'Salt and pepper. Nothing else.', image: '/brand/parts/patty.png',   width: 0.803, side: 'right', flip: true },
        { no: '01', name: 'Heel',  spec: 'Brioche.',                       image: '/brand/parts/heel.png',    width: 0.861, side: 'left',  flip: false },
      ],
    },
  },
  {
    variant: 'flipd.mission',
    label: 'Flipd mission',
    group: GROUP,
    description: 'A bone panel with the long read.',
    icon: 'MI',
    pages: HOME,
    summaryKey: 'headline',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'body', label: 'Body', kind: 'textarea', rows: 6 },
      { key: 'panelBg', label: 'Panel colour', kind: 'color', hint: 'Empty = bone.' },
    ],
    defaults: {
      eyebrow: 'Our mission',
      headline: 'Same burger, every time.',
      body: 'Every burger is built on quality ingredients and a fixed spec, whether you just came off the court or came only for the food. Same burger, every time. Consistency isn’t a value-add here; it’s the product. Patties are seasoned with salt and pepper, nothing else, because you should taste the meat. We build with real components, not sauce, going against where the market’s headed. Drinks follow the same logic: electrolytes, coconut water, sparkling water — fuel that fits the food and fits the court.',
      panelBg: '',
    },
  },
  {
    variant: 'flipd.values',
    label: 'Flipd core values',
    group: GROUP,
    description: 'Numbered values on the inverted blue band — the brand book\'s own words.',
    icon: 'CV',
    pages: HOME,
    summaryKey: 'headline',
    fields: [
      { key: 'headline', label: 'Headline', kind: 'text' },
      {
        key: 'items', label: 'Values', kind: 'list', itemLabel: 'Value', max: 8,
        item: [
          { key: 'title', label: 'Title', kind: 'text' },
          { key: 'body', label: 'Body', kind: 'textarea', rows: 3 },
        ],
      },
      { key: 'bg', label: 'Band colour', kind: 'color', hint: 'Empty = Flipd Blue.' },
      { key: 'fg', label: 'Text colour', kind: 'color', hint: 'Empty = Smash Mustard.' },
    ],
    defaults: {
      headline: 'What we hold to.',
      items: [
        {
          title: 'The spec is the boss.',
          body: 'Every burger is built the same way by whoever is on the line. Recipes are written, weights are weighed, no one improvises during service.',
        },
        {
          title: 'Restraint over decoration.',
          body: 'Salt and pepper. Components, not sauce. We don’t hide a weak ingredient behind a strong one. If something on the plate isn’t earning its place, it comes off.',
        },
        {
          title: 'Buy the ingredient, not the price.',
          body: 'A naked patty means the beef has nowhere to hide. Food cost holds by managing yield and waste, never by downgrading the protein.',
        },
        {
          title: 'Fuel is a responsibility, not a garnish.',
          body: 'Players are eating and drinking to recover. The electrolyte, coconut water and sparkling programme exists because it does a job — not because it reads well on a menu.',
        },
      ],
      bg: '',
      fg: '',
    },
  },
  {
    variant: 'flipd.visit',
    label: 'Flipd hours & where',
    group: GROUP,
    description: 'Live open/closed, opening hours, address, phone, email and the booking button.',
    icon: 'HW',
    pages: HOME,
    summaryKey: 'whereHeadline',
    fields: [
      { key: 'hoursEyebrow', label: 'Hours — eyebrow', kind: 'text' },
      { key: 'hoursHeadline', label: 'Hours — headline', kind: 'text' },
      { key: 'hoursEmpty', label: 'Hours — when none are published', kind: 'text' },
      { key: 'whereEyebrow', label: 'Where — eyebrow', kind: 'text' },
      { key: 'whereHeadline', label: 'Where — headline', kind: 'text' },
      { key: 'address', label: 'Address', kind: 'text', hint: 'Empty = the brand\'s live address.' },
      { key: 'addressMissing', label: 'Address when none is set', kind: 'text' },
      { key: 'phone', label: 'Phone', kind: 'text', hint: 'Empty = the brand\'s live phone.' },
      { key: 'email', label: 'Email', kind: 'text', hint: 'Empty = the brand\'s live guest email.' },
      { key: 'book', label: 'Booking button', kind: 'link', hint: 'Shown only while reservations are on for the brand. Empty text = hidden. ' + LINK_HINT },
    ],
    defaults: {
      hoursEyebrow: 'Hours',
      hoursHeadline: 'When we’re on.',
      hoursEmpty: 'Hours not published yet.',
      whereEyebrow: 'Where',
      whereHeadline: 'Find us.',
      address: '',
      addressMissing: 'Karachi · address TBA',
      phone: '',
      email: '',
      book: { text: 'Book a table', href: '@book' },
    },
  },
  {
    variant: 'flipd.crossBrand',
    label: 'Flipd other kitchens',
    group: GROUP,
    description: 'The brand\'s sibling kitchens from the same company (live).',
    icon: 'OK',
    pages: HOME,
    summaryKey: 'heading',
    fields: [
      { key: 'kicker', label: 'Kicker', kind: 'text' },
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'subtitle', label: 'Line under the heading', kind: 'textarea', rows: 2, hint: 'Empty hides it.' },
      { key: 'allLink', label: 'All-kitchens button', kind: 'link', hint: 'Empty label hides the button.' },
      { key: 'cardCta', label: 'Card button', kind: 'text', hint: '{name} = that kitchen, e.g. Visit {name} →' },
      { key: 'accent', label: 'Accent colour', kind: 'color', hint: 'Empty = Flipd Blue.' },
    ],
    defaults: {
      kicker: 'Also from the same kitchen group',
      heading: 'Other kitchens from the same group.',
      subtitle: 'Same operator, same standards. Different cuisine, different vibe — and you can pair them in one cart.',
      allLink: { text: 'See all kitchens →', href: '/home#kitchens' },
      cardCta: 'Visit {name} →',
      accent: '',
    },
  },
  {
    variant: 'flipd.signOff',
    label: 'Flipd sign-off',
    group: GROUP,
    description: 'The stamped badge again to close, on the blue band.',
    icon: 'SO',
    pages: HOME,
    summaryKey: 'caption',
    fields: [
      { key: 'badge', label: 'Badge', kind: 'image', hint: 'Empty = the brand\'s uploaded wordmark, else the bundled badge. Never recolour it.' },
      { key: 'badgeAlt', label: 'Badge description (alt text)', kind: 'text', hint: 'Read by search engines and screen readers. Empty = the brand\'s live name.' },
      { key: 'caption', label: 'Caption', kind: 'text', hint: 'Empty = the brand\'s live address.' },
      { key: 'captionMissing', label: 'Caption when no address is set', kind: 'text' },
      { key: 'bg', label: 'Band colour', kind: 'color', hint: 'Empty = Flipd Blue.' },
    ],
    defaults: {
      badge: '',
      badgeAlt: '',
      caption: '',
      captionMissing: 'Karachi',
      bg: '',
    },
  },
  {
    variant: 'flipd.menu',
    label: 'Flipd menu',
    group: GROUP,
    description: 'The live menu in Flipd\'s chrome — categories, prices, options and sold-out marks come from the kitchen\'s own list.',
    icon: 'MN',
    pages: MENU,
    summaryKey: 'headline',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'headingLead', label: 'Heading lead (hidden text)', kind: 'text', hint: 'Read before the headline by search engines and screen readers, not shown, so the page heading names the brand ("Flipd menu: Built to spec."). {{brand.name}} = the brand name. Empty = none.' },
      { key: 'intro', label: 'Intro', kind: 'textarea', rows: 3 },
      { key: 'primary', label: 'Order button', kind: 'link', hint: 'Empty link = @order. ' + LINK_HINT },
      { key: 'back', label: 'Back button', kind: 'link', hint: 'Empty text = "Back to <brand name>". Empty link = @home. ' + LINK_HINT },
      { key: 'jumpNav', label: 'Section jump-list', kind: 'toggle', hint: 'Shown only when there is more than one category.' },
      { key: 'soldOut', label: 'Sold-out label', kind: 'text' },
      { key: 'emptyHeadline', label: 'No menu yet — headline', kind: 'text' },
      { key: 'emptyBody', label: 'No menu yet — body', kind: 'text' },
      { key: 'emptyCta', label: 'No menu yet — button', kind: 'link', hint: 'Empty link = @order. ' + LINK_HINT },
      { key: 'closingHeadline', label: 'Closing headline', kind: 'text' },
      { key: 'closingCta', label: 'Closing button', kind: 'link', hint: 'Empty link = @order. ' + LINK_HINT },
    ],
    defaults: {
      eyebrow: 'The menu',
      headline: 'Built to spec.',
      headingLead: '{{brand.name}} menu:',
      intro: 'Every burger on a fixed build. Prices and what’s on today come straight from the kitchen’s own list.',
      primary: { text: 'Order now', href: '@order' },
      back: { text: '', href: '@home' },
      jumpNav: true,
      soldOut: 'Sold out',
      emptyHeadline: 'The menu isn’t up yet.',
      emptyBody: 'Call the counter and we’ll tell you what’s on.',
      emptyCta: { text: 'Go to ordering', href: '@order' },
      closingHeadline: 'Same burger, every time.',
      closingCta: { text: 'Order now', href: '@order' },
    },
  },
]

export const pages: PageDefault[] = [
  {
    slug: 'brand:flipd',
    sections: [
      { variant: 'flipd.checker' },
      { variant: 'flipd.specHero' },
      { variant: 'flipd.checker' },
      { variant: 'flipd.mission' },
      { variant: 'flipd.values' },
      { variant: 'flipd.visit' },
      { variant: 'flipd.checker' },
      { variant: 'flipd.crossBrand' },
      { variant: 'flipd.signOff' },
      { variant: 'flipd.checker' },
    ],
  },
  { slug: 'brand:flipd:menu', sections: [{ variant: 'flipd.menu' }] },
]
