// servd sections — catalogue (data only: no React, no imports from renderers).
// See ../README.md for the contract.
//
// Pages: servd:home (/home), servd:header (global nav), servd:footer (global
// footer), servd:waitlist, servd:press, servd:reserve (/reserve index) and
// servd:location (the /locations/[loc] template — sections read ctx.params.loc).
// The old `servd:hero` layout (one `scrollHero` block) and the `siteLogo` block
// on `servd:header` are retired: their content lives in servd.scrollHero and
// servd.nav.
import type { FieldSpec, PageDefault, SectionSpec } from '../types'

const BRAND_HINT = 'Brand slug, e.g. stackd, simmer, flipd'

const LOCATION_PLACEHOLDERS =
  'Placeholders: {name} {area} {district} {city} {address} {street} {tagline}. One with no value yet is left out, with the “ · ” beside it.'

const linkItem: FieldSpec[] = [
  { key: 'text', label: 'Label', kind: 'text' },
  { key: 'href', label: 'Link', kind: 'url' },
]

export const specs: SectionSpec[] = [
  // ─── servd:home ──────────────────────────────────────────────────────────
  {
    variant: 'servd.scrollHero',
    label: 'servd scroll hero',
    group: 'servd',
    description: 'The media grows to fill the screen as the visitor scrolls, then the page releases.',
    icon: 'SH',
    pages: ['servd:home', 'page:*'],
    summaryKey: 'title',
    fields: [
      { key: 'mediaType', label: 'Media type', kind: 'select', options: [
        { value: 'video', label: 'Video' }, { value: 'image', label: 'Image' },
      ] },
      { key: 'mediaSrc', label: 'Expanding video', kind: 'video', hint: 'Video file or a YouTube link. Used when Media type is Video. Loads after the page is ready; keep it small (1280×720, no sound).' },
      { key: 'mediaImage', label: 'Expanding image', kind: 'image', hint: 'Used when Media type is Image.' },
      { key: 'posterSrc', label: 'Video poster', kind: 'image', hint: 'Shown until the video starts, and instead of it for visitors who prefer less motion or save data. Optional.' },
      { key: 'mediaAlt', label: 'Media description (alt text)', kind: 'text', hint: 'What the video/photo shows. Empty = decorative' },
      { key: 'bgImageSrc', label: 'Background image', kind: 'image', hint: 'Empty = plain servd purple.' },
      { key: 'title', label: 'Title', kind: 'text', hint: 'The first word slides left, the rest slides right.' },
      { key: 'headingLevel', label: 'Title tag', kind: 'select', hint: 'H1 = the page’s main title (one per page). Use H2 on a page that already has an H1.', options: [
        { value: 'h1', label: 'H1 (page title)' }, { value: 'h2', label: 'H2 (section heading)' },
      ] },
      { key: 'date', label: 'Eyebrow', kind: 'text', hint: 'Small line on the media. Empty = none.' },
      { key: 'scrollToExpand', label: 'Scroll hint', kind: 'text', hint: 'Empty = none.' },
      { key: 'textBlend', label: 'Blend title with the media', kind: 'toggle', hint: 'Difference blend. Off reads better over a busy video.' },
      { key: 'overview', label: 'Intro', kind: 'textarea', hint: 'Shown once the media is fully open. Empty = none.' },
      { key: 'conclusion', label: 'Sub-intro', kind: 'textarea', hint: 'Empty = none.' },
      { key: 'primaryCta', label: 'Main button', kind: 'link', hint: 'Empty label = no button.' },
      { key: 'secondaryCta', label: 'Second link', kind: 'link', hint: 'Link #search opens the search sheet. Empty label = none.' },
    ],
    defaults: {
      mediaType: 'video',
      mediaSrc: 'https://videos.pexels.com/video-files/854565/854565-hd_1920_1080_25fps.mp4',
      mediaImage: '',
      posterSrc: '',
      mediaAlt: '',
      bgImageSrc: '',
      title: 'Every kitchen. One order.',
      headingLevel: 'h1',
      date: 'order · explore · insiders',
      scrollToExpand: 'Scroll to explore',
      textBlend: false,
      overview: 'Simmer, Stackd and Flipd. Order from one kitchen or all three, and check out once.',
      conclusion: 'Join Insiders for rewards on every order.',
      primaryCta: { text: 'Order now', href: '#kitchens' },
      secondaryCta: { text: 'Search the menus', href: '#search' },
    },
  },
  {
    variant: 'servd.kitchens',
    label: 'servd kitchens (brand tiles)',
    group: 'servd',
    description: 'One rounded tile per kitchen in its own palette, with Order and Learn more. Anchor #kitchens.',
    icon: 'KT',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'tiles', label: 'Tiles', kind: 'list', itemLabel: 'Tile', max: 8, item: [
        { key: 'brand', label: 'Brand', kind: 'text', hint: `${BRAND_HINT}. The tile colours and wordmark follow the brand.` },
        { key: 'tagline', label: 'Tagline', kind: 'text', hint: 'Empty = the brand’s own tagline.' },
        { key: 'orderText', label: 'Order button', kind: 'text' },
        { key: 'learnMoreText', label: 'Learn more link', kind: 'text', hint: 'Goes to the brand’s own site (e.g. stackd.pk). Empty = no link.' },
        { key: 'art', label: 'Art image', kind: 'image', hint: 'Empty = none (Simmer: its low sun).' },
        { key: 'wide', label: 'Full width', kind: 'toggle' },
        { key: 'hidden', label: 'Hide this tile', kind: 'toggle' },
      ] },
    ],
    defaults: {
      heading: 'Three kitchens. Pick one, or all of them.',
      tiles: [
        { brand: 'stackd', tagline: '', orderText: 'Order', learnMoreText: 'Learn more', art: '/brand/stackd-mascot.png', wide: true, hidden: false },
        { brand: 'simmer', tagline: '', orderText: 'Order', learnMoreText: 'Learn more', art: '', wide: false, hidden: false },
        { brand: 'flipd', tagline: '', orderText: 'Order', learnMoreText: 'Learn more', art: '/brand/flipd-badge.png', wide: false, hidden: false },
      ],
    },
  },
  {
    variant: 'servd.howItWorks',
    label: 'servd how it works',
    group: 'servd',
    description: 'A heading over three icon + title + line columns.',
    icon: 'HW',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'items', label: 'Columns', kind: 'list', itemLabel: 'Column', max: 6, item: [
        { key: 'icon', label: 'Icon', kind: 'select', options: [
          { value: 'stack', label: 'Stack' }, { value: 'clock', label: 'Clock' }, { value: 'star', label: 'Star' },
          { value: 'none', label: 'None' },
        ] },
        { key: 'title', label: 'Title', kind: 'text' },
        { key: 'body', label: 'Text', kind: 'textarea' },
      ] },
    ],
    defaults: {
      heading: 'One order. Every kitchen.',
      items: [
        { icon: 'stack', title: 'Mix kitchens.', body: 'Add a Stackd pastry to a Flipd order. One cart, one checkout.' },
        { icon: 'clock', title: 'Timed together.', body: 'We hold the quickest dish for the slowest, so everything lands as it should.' },
        { icon: 'star', title: 'Rewarded everywhere.', body: 'Insiders earn on every order, at every kitchen.' },
      ],
    },
  },
  {
    variant: 'servd.insiders',
    label: 'servd Insiders band',
    group: 'servd',
    description: 'The purple Insiders band: headline, join buttons, perks, sign-in line. Anchor #insiders.',
    icon: 'IN',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'headline',
    fields: [
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'sub', label: 'Sub-headline', kind: 'textarea' },
      { key: 'primaryCta', label: 'Join button', kind: 'link', hint: 'Empty label = no button.' },
      { key: 'secondaryCta', label: 'Second link', kind: 'link', hint: 'Empty link = WhatsApp (brand + message below; hidden while that brand has no WhatsApp number). Empty label = none.' },
      { key: 'whatsappBrand', label: 'WhatsApp number of', kind: 'text', hint: BRAND_HINT },
      { key: 'whatsappMessage', label: 'WhatsApp message', kind: 'text' },
      { key: 'perks', label: 'Perks', kind: 'list', itemLabel: 'Perk', max: 6, item: [
        { key: 'tag', label: 'Tag', kind: 'text' },
        { key: 'head', label: 'Title', kind: 'text' },
        { key: 'body', label: 'Text', kind: 'textarea' },
      ] },
      { key: 'signIn', label: 'Sign-in line', kind: 'link', hint: 'Empty label = none.' },
      { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = servd purple.' },
    ],
    defaults: {
      headline: 'The best stuff doesn’t get listed.',
      sub: 'Limited drops, off-menu plates and points on every order. Insiders hear first. Free to join.',
      primaryCta: { text: 'Join Insiders', href: '/signup?insider=1' },
      secondaryCta: { text: 'Join on WhatsApp', href: '' },
      whatsappBrand: 'simmer',
      whatsappMessage: 'add me to servd insiders',
      // Per-brand perks — Simmer gets recognition (no points, no coupon
      // language); Stackd and Flipd get a plain points mechanic.
      perks: [
        { tag: 'Simmer · regulars', head: 'The regulars’ list',
          body: 'First word on the next menu. A held table when the room is full. Now and then the kitchen sends something out.' },
        { tag: 'Stackd · counter club', head: 'Five coffees in, the sixth is ours.',
          body: 'Buy five drinks and the sixth is on the house. First look at the pastry case before the morning bake goes out.' },
        { tag: 'Flipd · points', head: 'Points on every box.',
          body: '1 point per Rs. 10. Free weekday lunch delivery for members. Redeem 2,000 points for a meal.' },
      ],
      signIn: { text: 'Already a member? Sign in', href: '/login' },
      bg: '',
    },
  },
  {
    variant: 'servd.visit',
    label: 'servd visit cards',
    group: 'servd',
    description: 'One card per kitchen: open-now pill, area, Order / Location / WhatsApp / Email. Anchor #visit.',
    icon: 'VI',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'brands', label: 'Kitchens', kind: 'list', itemLabel: 'Kitchen', max: 8, item: [
        { key: 'brand', label: 'Brand', kind: 'text', hint: `${BRAND_HINT}. Name, area, WhatsApp and email are live.` },
      ] },
      { key: 'orderText', label: 'Order link', kind: 'text', hint: 'Empty = none.' },
      { key: 'locationText', label: 'Location link', kind: 'text', hint: 'Opens the kitchen’s /locations page (shown once it has an address). Empty = none.' },
      { key: 'whatsappText', label: 'WhatsApp link', kind: 'text', hint: 'Shown when the kitchen has a WhatsApp number. Empty = none.' },
      { key: 'whatsappGreeting', label: 'WhatsApp message', kind: 'text', hint: '{brand} = the kitchen’s name.' },
      { key: 'emailText', label: 'Email link', kind: 'text', hint: 'Empty = none.' },
      { key: 'pillFallback', label: 'Open-now pill before hours load', kind: 'text' },
    ],
    defaults: {
      heading: 'Come by.',
      brands: [{ brand: 'stackd' }, { brand: 'simmer' }, { brand: 'flipd' }],
      orderText: 'Order',
      locationText: 'Location',
      whatsappText: 'WhatsApp',
      whatsappGreeting: 'hi {brand}',
      emailText: 'Email',
      pillFallback: 'Karachi',
    },
  },
  {
    variant: 'servd.waitlistStrip',
    label: 'servd waitlist strip',
    group: 'servd',
    description: 'A centred heading, line and link to the waitlist.',
    icon: 'WS',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'body', label: 'Line', kind: 'text' },
      { key: 'cta', label: 'Link', kind: 'link', hint: 'Empty label = none.' },
    ],
    defaults: {
      heading: 'There’s another kitchen coming.',
      body: 'Be the first to know when it opens.',
      cta: { text: 'Join the waitlist', href: '/waitlist' },
    },
  },

  // ─── servd:header ────────────────────────────────────────────────────────
  {
    variant: 'servd.nav',
    label: 'servd nav bar',
    group: 'servd',
    description: 'The glass nav on servd.pk: logo, section links, search, account and Order. Hidden on brand sites, sign-in and ordering pages.',
    icon: 'NV',
    pages: ['servd:header'],
    summaryKey: 'logoAlt',
    fields: [
      { key: 'logo', label: 'Logo image', kind: 'image', hint: 'Empty = the text wordmark.' },
      { key: 'logoHeight', label: 'Logo height (px)', kind: 'number', min: 16, max: 44, step: 1 },
      { key: 'logoAlt', label: 'Logo alt text', kind: 'text' },
      { key: 'wordmark', label: 'Text wordmark', kind: 'text', hint: 'Shown when there is no logo image; a green dot follows it.' },
      { key: 'links', label: 'Links', kind: 'list', itemLabel: 'Link', max: 8, item: linkItem },
      { key: 'showOrders', label: 'Show the Orders link to signed-in customers', kind: 'toggle' },
      { key: 'ordersLink', label: 'Orders link', kind: 'link' },
      { key: 'showSearch', label: 'Show search', kind: 'toggle' },
      { key: 'showAccount', label: 'Show account / sign in', kind: 'toggle' },
      { key: 'cta', label: 'Button', kind: 'link', hint: 'Empty label = no button.' },
    ],
    defaults: {
      logo: '',
      logoHeight: 28,
      logoAlt: 'servd',
      wordmark: 'servd',
      links: [
        { text: 'Kitchens', href: '/home#kitchens' },
        { text: 'Insiders', href: '/home#insiders' },
        { text: 'Visit', href: '/home#visit' },
      ],
      showOrders: true,
      ordersLink: { text: 'Orders', href: '/orders' },
      showSearch: true,
      showAccount: true,
      cta: { text: 'Order', href: '/home#kitchens' },
    },
  },

  // ─── servd:footer ────────────────────────────────────────────────────────
  {
    variant: 'servd.footer',
    label: 'servd footer',
    group: 'servd',
    description: 'The purple servd footer: CTA band, link columns, copyright. Hidden on brand sites.',
    icon: 'FT',
    pages: ['servd:footer'],
    summaryKey: 'headline',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
      { key: 'headline', label: 'Headline', kind: 'text' },
      { key: 'headlineAccent', label: 'Headline accent (italic, green)', kind: 'text' },
      { key: 'cta', label: 'Button', kind: 'link', hint: 'Empty label = no button.' },
      { key: 'wordmark', label: 'Wordmark', kind: 'text' },
      { key: 'wordmarkHref', label: 'Wordmark link', kind: 'url', hint: 'Empty or / = the servd home (/home).' },
      { key: 'blurb', label: 'Blurb', kind: 'textarea' },
      { key: 'kitchensHeading', label: 'Kitchens heading', kind: 'text' },
      { key: 'kitchens', label: 'Kitchens', kind: 'list', itemLabel: 'Kitchen', max: 10, item: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'href', label: 'Link', kind: 'url', hint: 'The brand’s own site, e.g. https://stackd.pk/. A /brand/<slug> link is sent there too.' },
        { key: 'dot', label: 'Dot colour', kind: 'color' },
      ] },
      { key: 'customerHeading', label: 'Customer heading', kind: 'text' },
      { key: 'customerLinks', label: 'Customer links', kind: 'list', itemLabel: 'Link', max: 10, item: linkItem },
      { key: 'companyHeading', label: 'Company heading', kind: 'text' },
      { key: 'companyLines', label: 'Company lines', kind: 'list', itemLabel: 'Line', max: 10, item: [
        { key: 'text', label: 'Text', kind: 'text' },
        { key: 'href', label: 'Link', kind: 'url', hint: 'Empty = plain text. mailto:… for an email.' },
      ] },
      { key: 'copyright', label: 'Copyright', kind: 'text', hint: '{year} = the current year.' },
      { key: 'tagline', label: 'Bottom line', kind: 'text' },
      { key: 'accent', label: 'Accent colour', kind: 'color', hint: 'Empty = servd green.' },
    ],
    defaults: {
      eyebrow: 'One place for every kitchen',
      headline: 'Hungry now?',
      headlineAccent: "Let's go.",
      cta: { text: 'Order now', href: '/home#kitchens' },
      wordmark: 'servd',
      wordmarkHref: '/home',
      blurb: 'Every kitchen in one place — order what you are craving, explore the brands, and join Insiders.',
      kitchensHeading: 'Kitchens',
      // Live brands only; accents match the canonical per-brand palette.
      kitchens: [
        { name: 'Stackd', href: 'https://stackd.pk/', dot: '#FCE8CE' },
        { name: 'Simmer', href: 'https://simmer.pk/', dot: '#E94E1B' },
        { name: 'Flipd', href: 'https://flipd.pk/', dot: '#2092E9' },
      ],
      customerHeading: 'Customer',
      customerLinks: [
        { text: 'All kitchens', href: '/home#kitchens' },
        { text: 'Reserve a table', href: '/reserve' },
        { text: 'Waitlist', href: '/waitlist' },
        { text: 'My account', href: '/account' },
        { text: 'Order history', href: '/orders' },
        { text: 'Sign in', href: '/login' },
      ],
      companyHeading: 'Company',
      companyLines: [
        { text: 'GS Foods Pvt. Ltd.', href: '' },
        { text: 'Karachi · Pakistan', href: '' },
        { text: 'servd@gsfoods.pk', href: 'mailto:servd@gsfoods.pk' },
        { text: 'Press', href: '/press' },
      ],
      copyright: '© {year} GS Foods. All rights reserved.',
      tagline: 'Made in Karachi. Cooked in Karachi. For Karachi.',
      accent: '',
    },
  },

  // ─── Shared page header (press, reserve, custom pages) ────────────────────
  {
    variant: 'servd.pageHeader',
    label: 'servd page header',
    group: 'servd',
    description: 'Eyebrow, a big two-line title (second line italic) and an intro.',
    icon: 'PH',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'title',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: 'Empty = none.' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'titleAccent', label: 'Title second line (italic)', kind: 'text', hint: 'Empty = none.' },
      { key: 'body', label: 'Intro', kind: 'textarea', hint: 'Empty = none.' },
      { key: 'tight', label: 'Tighter title spacing', kind: 'toggle' },
    ],
    defaults: {
      eyebrow: 'For press & creators',
      title: 'Writing about food',
      titleAccent: 'in Karachi?',
      body: 'Three kitchens, one operator. Below is what’s on offer, who to reach, and what we don’t do.',
      tight: true,
    },
  },

  // ─── servd:press ─────────────────────────────────────────────────────────
  {
    variant: 'servd.pressCards',
    label: 'servd press cards',
    group: 'servd',
    description: 'Cards with a title, bullet points, a paragraph and a button (one can message the press WhatsApp).',
    icon: 'PC',
    pages: ['servd:press', 'servd:*', 'page:*'],
    summaryKey: 'whatsappMessage',
    fields: [
      { key: 'cards', label: 'Cards', kind: 'list', itemLabel: 'Card', max: 6, item: [
        { key: 'title', label: 'Title', kind: 'text' },
        { key: 'bullets', label: 'Bullet points', kind: 'textarea', rows: 5, hint: 'One per line. Empty = none.' },
        { key: 'body', label: 'Paragraph', kind: 'textarea', hint: 'Empty = none.' },
        { key: 'button', label: 'Button', kind: 'link', hint: 'Link #whatsapp = message the press contact (hidden while that brand has no WhatsApp number). Empty label = none.' },
      ] },
      { key: 'whatsappBrand', label: 'Press WhatsApp number of', kind: 'text', hint: BRAND_HINT },
      { key: 'whatsappMessage', label: 'Press WhatsApp message', kind: 'textarea' },
    ],
    defaults: {
      cards: [
        { title: 'What’s on offer', body: '', button: { text: '', href: '' }, bullets: [
          'Comp visits for verified creators with relevant audience',
          'Chef’s-table previews of new menu drops at Simmer',
          'First access to seasonal items and collab nights',
          'High-res food + room photography on request',
          'Background interviews with the chefs / operator',
        ].join('\n') },
        { title: 'What we don’t do', body: '', button: { text: '', href: '' }, bullets: [
          'Pay for posts framed as organic',
          'Trade comp meals for guaranteed five-star reviews',
          'Buy follower-count guarantees',
          'Brief on what to say — write honestly or skip it',
        ].join('\n') },
        { title: 'Get in touch', bullets: '',
          body: 'Message on WhatsApp with your handle, audience, and which brand you’re curious about. We’ll reply within two business days.',
          button: { text: 'Message us on WhatsApp →', href: '#whatsapp' } },
      ],
      // Simmer is the press-friendliest of the three (premium, room-led,
      // reservation-based).
      whatsappBrand: 'simmer',
      whatsappMessage: 'hi servd — press inquiry. handle: @ / audience: / brand: ',
    },
  },

  // ─── servd:reserve ───────────────────────────────────────────────────────
  {
    variant: 'servd.reservePicker',
    label: 'servd reservation picker',
    group: 'servd',
    description: 'A card per brand that takes reservations (live), linking to its booking page.',
    icon: 'RP',
    pages: ['servd:reserve', 'servd:*', 'page:*'],
    summaryKey: 'cardCta',
    fields: [
      { key: 'cardCta', label: 'Card link text', kind: 'text', hint: '{brand} = the brand’s name.' },
      { key: 'pillFallback', label: 'Open-now pill before hours load', kind: 'text' },
      { key: 'emptyText', label: 'When no brand takes reservations', kind: 'text' },
      { key: 'emptyCta', label: 'Button when none', kind: 'link', hint: 'Empty label = none.' },
    ],
    defaults: {
      cardCta: 'Book at {brand} →',
      pillFallback: 'Dine-in',
      emptyText: 'No brands are accepting reservations right now.',
      emptyCta: { text: 'Browse all kitchens', href: '/home#kitchens' },
    },
  },

  // ─── servd:waitlist ──────────────────────────────────────────────────────
  {
    variant: 'servd.waitlistSignup',
    label: 'servd waitlist sign-up',
    group: 'servd',
    description: 'The new-brand waitlist: pitch and checklist beside the WhatsApp-verified form.',
    icon: 'WL',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'title',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: 'Empty = none.' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'body', label: 'Intro', kind: 'textarea' },
      { key: 'points', label: 'Checklist', kind: 'list', itemLabel: 'Point', max: 8, item: [
        { key: 'text', label: 'Text', kind: 'text' },
      ] },
      { key: 'formTitle', label: 'Form title', kind: 'text' },
      { key: 'formSubtitle', label: 'Form sub-title', kind: 'textarea' },
      { key: 'formButton', label: 'Form button', kind: 'text' },
    ],
    defaults: {
      eyebrow: 'The servd waitlist',
      title: 'Be first in line.',
      body: 'servd keeps opening new kitchens in Karachi. Leave your number and we will tell you the day the next one opens, before anyone else hears about it.',
      points: [
        { text: 'One message when a new brand opens. No spam.' },
        { text: 'Your number is confirmed with a WhatsApp code.' },
        { text: 'Opt out any time.' },
      ],
      formTitle: 'Join the list.',
      formSubtitle: 'It takes a minute. We only ask for what we need to reach you.',
      formButton: 'Send code',
    },
  },

  // ─── servd:location (/locations/[loc]) ───────────────────────────────────
  {
    variant: 'servd.locationHero',
    label: 'Location header',
    group: 'servd',
    description: 'The location page header. Live name, area and city fill the placeholders.',
    icon: 'LH',
    pages: ['servd:location'],
    summaryKey: 'title',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: LOCATION_PLACEHOLDERS },
      { key: 'title', label: 'Title', kind: 'text', hint: LOCATION_PLACEHOLDERS },
      { key: 'body', label: 'Intro', kind: 'textarea', hint: LOCATION_PLACEHOLDERS },
    ],
    defaults: {
      eyebrow: '{city} · {district}',
      title: '{name} · {area}',
      body: '{tagline}',
    },
  },
  {
    variant: 'servd.locationDetails',
    label: 'Location details',
    group: 'servd',
    description: 'Find-us and Visit cards (live address, phone, WhatsApp, email) and the embedded map.',
    icon: 'LD',
    pages: ['servd:location'],
    summaryKey: 'findTitle',
    fields: [
      { key: 'findTitle', label: 'Find-us card title', kind: 'text' },
      { key: 'mapsText', label: 'Maps button', kind: 'text', hint: 'Shown once the location has a map pin or an address. Empty = none.' },
      { key: 'callText', label: 'Call button', kind: 'text', hint: 'Shown when the brand has a phone number. Empty = none.' },
      { key: 'whatsappText', label: 'WhatsApp button', kind: 'text', hint: 'Shown when the brand has a WhatsApp number. Empty = none.' },
      { key: 'whatsappGreeting', label: 'WhatsApp message', kind: 'text', hint: LOCATION_PLACEHOLDERS },
      { key: 'emailText', label: 'Email button', kind: 'text', hint: 'Shown when the brand has an email. Empty = none.' },
      { key: 'visitTitle', label: 'Visit card title', kind: 'text' },
      { key: 'reservationsBody', label: 'Visit text (takes reservations)', kind: 'textarea', hint: LOCATION_PLACEHOLDERS },
      { key: 'walkInBody', label: 'Visit text (walk-in)', kind: 'textarea', hint: LOCATION_PLACEHOLDERS },
      { key: 'menuText', label: 'Menu button', kind: 'text', hint: 'Opens the menu on the brand’s own site. Empty = none.' },
      { key: 'bookText', label: 'Book button (reservation brands)', kind: 'text', hint: 'Empty = none.' },
      { key: 'orderText', label: 'Order button', kind: 'text', hint: 'Empty = none.' },
      { key: 'showMap', label: 'Show the map', kind: 'toggle' },
    ],
    defaults: {
      findTitle: 'Find us',
      mapsText: 'Open in Maps →',
      callText: 'Call',
      whatsappText: 'WhatsApp',
      whatsappGreeting: 'hi {name}',
      emailText: 'Email',
      visitTitle: 'Visit',
      reservationsBody: '{name} takes reservations — secure your table or browse the current menu.',
      walkInBody: '{name} is walk-in friendly. Order ahead for pickup, curbside, or delivery.',
      menuText: 'See the menu →',
      bookText: 'Book a table',
      orderText: 'Order now',
      showMap: true,
    },
  },
]

export const pages: PageDefault[] = [
  {
    slug: 'servd:home',
    sections: [
      { variant: 'servd.scrollHero' },
      { variant: 'servd.kitchens' },
      { variant: 'servd.howItWorks' },
      { variant: 'servd.insiders' },
      { variant: 'servd.visit' },
      { variant: 'servd.waitlistStrip' },
    ],
  },
  { slug: 'servd:header', sections: [{ variant: 'servd.nav' }] },
  { slug: 'servd:footer', sections: [{ variant: 'servd.footer' }] },
  { slug: 'servd:waitlist', sections: [{ variant: 'servd.waitlistSignup' }] },
  {
    slug: 'servd:press',
    sections: [{ variant: 'servd.pageHeader' }, { variant: 'servd.pressCards' }],
  },
  {
    slug: 'servd:reserve',
    sections: [
      { variant: 'servd.pageHeader', fields: {
        eyebrow: 'Reservations',
        title: 'Book a table.',
        titleAccent: 'Pick the kitchen.',
        body: 'These brands hold the room for you — pick one to choose your party size and time.',
        tight: false,
      } },
      { variant: 'servd.reservePicker' },
    ],
  },
  {
    slug: 'servd:location',
    sections: [{ variant: 'servd.locationHero' }, { variant: 'servd.locationDetails' }],
  },
]
