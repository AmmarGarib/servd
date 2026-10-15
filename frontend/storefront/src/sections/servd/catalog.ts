// servd sections — catalogue (data only: no React, no imports from renderers).
// See ../README.md for the contract.
//
// Pages: servd:home (/home), servd:header (global nav), servd:footer (global
// footer), servd:feedback (the floating feedback button and its sheet),
// servd:waitlist, servd:about, servd:faq, servd:press, servd:reserve (/reserve index) and
// servd:location (the /locations/[loc] template — sections read ctx.params.loc).
// The old `servd:hero` layout (one `scrollHero` block) and the `siteLogo` block
// on `servd:header` are retired: their content lives in servd.scrollHero and
// servd.nav.
import type { FieldSpec, PageDefault, SectionSpec } from '../types'
import { FEEDBACK_DEFAULTS } from './feedbackDefaults'
import { FAQ_DEFAULTS } from './faqData'

const BRAND_HINT = 'Brand slug, e.g. stackd, simmer, flipd'

const BOOKABLE_HINT =
  '{bookable} = the kitchens taking reservations right now (live), e.g. “Simmer” or “Simmer or Stackd” — the same ones the reservation picker shows.'

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
      { key: 'posterSrc', label: 'Video poster', kind: 'image', hint: 'Shown until the video starts, and instead of it for visitors who prefer less motion or save data. The default is a still of the default video: replace or clear it when you change the video. Empty = none.' },
      { key: 'mediaAlt', label: 'Media description (alt text)', kind: 'text', hint: 'What the video/photo shows (the default describes the default video — rewrite it when you change it). Empty = decorative' },
      { key: 'bgSlides', label: 'Background slideshow', kind: 'list', itemLabel: 'Photo', max: 10, hint: 'Photos behind the media, cross-fading one after another; the whole background fades out as the media opens. Empty = the single background image below.', item: [
        { key: 'src', label: 'Photo', kind: 'image' },
        { key: 'alt', label: 'What it shows (alt text)', kind: 'text', hint: 'Empty = decorative' },
      ] },
      { key: 'bgSlideSeconds', label: 'Seconds per photo', kind: 'number', min: 3, max: 15, step: 1 },
      { key: 'bgImageSrc', label: 'Background image (single)', kind: 'image', hint: 'Used only when the slideshow is empty. Empty too = plain servd purple.' },
      { key: 'title', label: 'Title', kind: 'text', hint: 'The page heading. Shown on the media only when “Show the title” is on (the first word slides left, the rest slides right); otherwise search engines and screen readers still get it.' },
      { key: 'showTitle', label: 'Show the title on the media', kind: 'toggle', hint: 'Off = no words over the media.' },
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
      mediaSrc: 'https://videos.pexels.com/video-files/854565/854565-hd_1280_720_25fps.mp4',
      mediaImage: '',
      // A still of the default clip at 1s (1280x720 WebP), so the box shows
      // food from the first paint instead of an empty purple panel.
      posterSrc: '/brand/servd-hero-poster.webp',
      mediaAlt: 'Garlic and spring onion stirred in a hot wok with a wooden spatula',
      // The dining-room photo behind the hero (owner, 2026-10-12: "I had a
      // photo behind this"). Self-hosted 1600px WebP.
      bgImageSrc: '/brand/servd-hero-bg.webp',
      // The slideshow (owner, 2026-10-12): starts with the one photo; the owner
      // adds more in Admin -> Storefront.
      bgSlides: [{ src: '/brand/servd-hero-bg.webp', alt: '' }],
      bgSlideSeconds: 6,
      // Each kitchen has its own basket and checkout, so no "one order" /
      // "check out once" promise.
      title: 'Every kitchen, one place to order.',
      // No words over the media (owner, 2026-10-12: "kill all this text").
      showTitle: false,
      headingLevel: 'h1',
      date: '',
      scrollToExpand: '',
      textBlend: false,
      // No words or buttons after the expansion either (owner, 2026-10-15: "redundant, kill it — the brand cards
      // under it cover everything"). The fields stay editable in Admin -> Storefront.
      overview: '',
      conclusion: '',
      primaryCta: { text: '', href: '#kitchens' },
      secondaryCta: { text: '', href: '#search' },
    },
  },
  {
    variant: 'servd.kitchens',
    label: 'servd kitchens (brand cards)',
    group: 'servd',
    description: 'The kitchens as a hand of trading cards in each brand’s own colours: a /slug tab flips a card to its stats. Anchor #kitchens.',
    icon: 'KT',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
      { key: 'heading', label: 'Heading', kind: 'textarea', hint: 'Two lines: the last line is set in italics.' },
      { key: 'lead', label: 'Lead', kind: 'textarea' },
      { key: 'note', label: 'Handwritten note', kind: 'text', hint: 'Handwritten note with an arrow. Empty = none.' },
      { key: 'backLabel', label: 'Back label', kind: 'text', hint: 'Back of the card: heading over the stats' },
      { key: 'hoursLabel', label: 'Hours label', kind: 'text' },
      { key: 'backFoot', label: 'Back footer', kind: 'text', hint: 'Empty = none.' },
      { key: 'flipBackText', label: 'Flip-back text', kind: 'text' },
      { key: 'tiles', label: 'Cards', kind: 'list', itemLabel: 'Card', max: 8, item: [
        { key: 'brand', label: 'Brand', kind: 'text', hint: `${BRAND_HINT}. The card colours, wordmark and tab follow the brand.` },
        { key: 'kind', label: 'Kind', kind: 'text', hint: 'Small label on the photo, e.g. “smash burgers”. Empty = the built-in one.' },
        { key: 'tagline', label: 'Tagline', kind: 'text', hint: 'Empty = the brand’s own tagline.' },
        { key: 'highlights', label: 'Highlights', kind: 'textarea', hint: 'One per line, up to 3: chips on the front, stats on the back. Empty = the brand’s own.' },
        { key: 'photo', label: 'Photo', kind: 'image', hint: 'Empty = the brand’s own card photo.' },
        { key: 'art', label: 'Sticker', kind: 'image', hint: 'Empty = none (Simmer has none by design).' },
        { key: 'orderText', label: 'Order button', kind: 'text', hint: '{name} = the brand name. Empty = no button.' },
        { key: 'learnMoreText', label: 'Name link (to the brand’s own site)', kind: 'text', hint: '{name} = the brand name. Empty = the name is not a link.' },
        { key: 'hidden', label: 'Hide this card', kind: 'toggle' },
      ] },
    ],
    // Ported from Hasham's playful-arena build (owner 2026-10-15: these cards
    // instead of the old tiles). Each kitchen keeps its own basket, so there is
    // no "one bag" promise in the copy.
    defaults: {
      eyebrow: 'The kitchens',
      heading: 'Pick one. Pick two.\nPick all of them.',
      lead: 'Three kitchens, each with its own menu and its own basket. Open one, see what’s cooking, and order.',
      note: 'flip a card to meet the kitchen',
      backLabel: 'kitchen stats',
      hoursLabel: 'hours',
      backFoot: 'collect all three',
      flipBackText: 'flip back',
      tiles: [
        { brand: 'stackd', kind: '', tagline: '', highlights: '', photo: '/brand/stackd-card-photo.webp', art: '/brand/stackd-mascot.png', orderText: 'Order from {name}', learnMoreText: 'Visit {name}', hidden: false },
        { brand: 'simmer', kind: '', tagline: '', highlights: '', photo: '/brand/simmer-card-photo.webp', art: '', orderText: 'Order from {name}', learnMoreText: 'Visit {name}', hidden: false },
        { brand: 'flipd', kind: '', tagline: '', highlights: '', photo: '/brand/flipd-card-photo.webp', art: '/brand/flipd-badge.png', orderText: 'Order from {name}', learnMoreText: 'Visit {name}', hidden: false },
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
      heading: 'Every kitchen. One account.',
      items: [
        { icon: 'stack', title: 'Every menu, side by side.', body: 'Browse Stackd, Simmer and Flipd, then order from the kitchen you’re craving.' },
        { icon: 'clock', title: 'Timed together.', body: 'We hold the quickest dish for the slowest, so everything lands as it should.' },
        { icon: 'star', title: 'Rewarded everywhere.', body: 'Insiders earn on every order, at every kitchen.' },
      ],
    },
  },
  {
    variant: 'servd.insiders',
    label: 'servd Insiders (pass + perks)',
    group: 'servd',
    description: 'Insiders: headline, WhatsApp and email join buttons, the all-access pass, and one perk card per kitchen in its own colours. Anchor #insiders.',
    icon: 'IN',
    pages: ['servd:*', 'page:*'],
    summaryKey: 'headline',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
      { key: 'headline', label: 'Headline', kind: 'textarea', hint: 'Two lines: the last line is set in italics.' },
      { key: 'sub', label: 'Intro', kind: 'textarea' },
      { key: 'secondaryCta', label: 'WhatsApp button', kind: 'link', hint: 'Empty link = WhatsApp (brand + message below; hidden while that brand has no WhatsApp number). Empty label = none.' },
      { key: 'whatsappBrand', label: 'WhatsApp number of', kind: 'text', hint: BRAND_HINT },
      { key: 'whatsappMessage', label: 'WhatsApp message', kind: 'text' },
      { key: 'primaryCta', label: 'Email sign-up button', kind: 'link', hint: 'Empty label = none.' },
      { key: 'signIn', label: 'Sign-in line', kind: 'link', hint: 'Empty label = none.' },
      { key: 'finePrint', label: 'Fine print', kind: 'text', hint: 'After the sign-in link. Empty = none.' },
      { key: 'showPass', label: 'Show the pass', kind: 'toggle' },
      { key: 'passBrand', label: 'Pass brand', kind: 'text' },
      { key: 'passTier', label: 'Pass tier', kind: 'text' },
      { key: 'passTitle', label: 'Pass title', kind: 'textarea', hint: 'Last line in italics.' },
      { key: 'passFoot', label: 'Pass footer', kind: 'text' },
      { key: 'perks', label: 'Perks', kind: 'list', itemLabel: 'Perk', max: 6, item: [
        { key: 'brand', label: 'Brand', kind: 'text', hint: `${BRAND_HINT}. Card colours and icon follow it.` },
        { key: 'icon', label: 'Icon', kind: 'select', options: [
          { value: '', label: 'Brand default' }, { value: 'gem', label: 'Gem' },
          { value: 'coffee', label: 'Coffee cup' }, { value: 'trophy', label: 'Trophy' }, { value: 'none', label: 'None' },
        ] },
        { key: 'tag', label: 'Tag', kind: 'text' },
        { key: 'head', label: 'Title', kind: 'text' },
        { key: 'body', label: 'Text', kind: 'textarea' },
        { key: 'badge', label: 'Badge', kind: 'text', hint: 'Sticker on the card, e.g. “Most loved”; lifts the card. Empty = none.' },
        { key: 'stamps', label: 'Show the punch card', kind: 'toggle' },
        { key: 'stampsFreeText', label: 'Last stamp', kind: 'text' },
      ] },
      { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = servd lavender.' },
    ],
    defaults: {
      eyebrow: 'Insiders · free to join',
      headline: 'The best stuff\ndoesn’t get listed.',
      sub: 'Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.',
      secondaryCta: { text: 'Join on WhatsApp', href: '' },
      whatsappBrand: 'simmer',
      whatsappMessage: 'add me to servd insiders',
      primaryCta: { text: 'Or sign up with email', href: '/signup?insider=1' },
      signIn: { text: 'Already a member? Sign in', href: '/login' },
      finePrint: 'free forever · cancel anytime',
      showPass: true,
      passBrand: 'servd',
      passTier: 'insider',
      passTitle: 'All-access\npass',
      passFoot: 'free forever',
      // Per-brand perks — Simmer gets recognition (no points, no coupon
      // language); Stackd and Flipd get a plain points mechanic.
      perks: [
        { brand: 'simmer', icon: '', tag: 'Simmer · regulars', head: 'The regulars’ list',
          body: 'Quiet recognition. First word on the next menu drop. A held table when the room is full. Now and then the chef sends out a plate. No card, no points — you’re known here.',
          badge: '', stamps: false, stampsFreeText: 'free' },
        { brand: 'stackd', icon: '', tag: 'Stackd · counter club', head: 'Five coffees in, the sixth is on us',
          body: 'Buy five drinks at Stackd and the sixth is on the house. Insiders also get first look at the pastry case before the morning bake goes out to the floor.',
          badge: 'Most loved', stamps: true, stampsFreeText: 'free' },
        { brand: 'flipd', icon: '', tag: 'Flipd · points', head: 'Points on every box',
          body: 'Earn 1 point per Rs. 10 spent at Flipd. Free weekday lunch delivery for members. Redeem points for a meal at 2,000.',
          badge: '', stamps: false, stampsFreeText: 'free' },
      ],
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
      // The servd logo (green circle), not the text wordmark (owner, 2026-10-12).
      logo: '/brand/servd-logo.png',
      logoHeight: 34,
      logoAlt: 'servd',
      wordmark: 'servd',
      links: [
        { text: 'Kitchens', href: '/#kitchens' },
        { text: 'Insiders', href: '/#insiders' },
        { text: 'Visit', href: '/#visit' },
      ],
      showOrders: true,
      ordersLink: { text: 'Orders', href: '/orders' },
      showSearch: true,
      showAccount: true,
      cta: { text: 'Order', href: '/#kitchens' },
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
      // The cookie / analytics notice (components/analytics/Analytics.tsx),
      // shown on every servd and brand page while Google Analytics is set up.
      { key: 'consentText', label: 'Cookie notice: text', kind: 'textarea', hint: 'Shown until the visitor chooses (only when Google Analytics is configured).' },
      { key: 'consentLink', label: 'Cookie notice: privacy link', kind: 'link', hint: 'Empty label = no link.' },
      { key: 'consentDecline', label: 'Cookie notice: decline button', kind: 'text' },
      { key: 'consentAccept', label: 'Cookie notice: accept button', kind: 'text' },
    ],
    defaults: {
      consentText: 'We use Google Analytics to see which pages and dishes people use, so we can improve the site. It sets cookies only if you accept. Ordering works either way.',
      consentLink: { text: 'Privacy', href: 'https://servd.pk/privacy' },
      consentDecline: 'Only necessary',
      consentAccept: 'Accept',
      eyebrow: 'One place for every kitchen',
      headline: 'Hungry now?',
      headlineAccent: "Let's go.",
      cta: { text: 'Order now', href: '/#kitchens' },
      wordmark: 'servd',
      wordmarkHref: '/',
      blurb: 'Every kitchen in one place — order what you are craving, explore the brands, and join Insiders.',
      kitchensHeading: 'Kitchens',
      // Live brands only; accents match the canonical per-brand palette.
      kitchens: [
        { name: 'Stackd', href: 'https://stackd.pk/', dot: 'var(--stackd-cream)' },
        { name: 'Simmer', href: 'https://simmer.pk/', dot: 'var(--simmer-orange)' },
        { name: 'Flipd', href: 'https://flipd.pk/', dot: '#2092E9' },
      ],
      customerHeading: 'Customer',
      customerLinks: [
        { text: 'All kitchens', href: '/#kitchens' },
        { text: 'Reserve a table', href: '/reserve' },
        { text: 'Waitlist', href: '/waitlist' },
        { text: 'FAQ', href: '/faq' },
        { text: 'My account', href: '/account' },
        { text: 'Order history', href: '/orders' },
        { text: 'Sign in', href: '/login' },
      ],
      companyHeading: 'Company',
      companyLines: [
        { text: 'GS Foods Pvt. Ltd.', href: '' },
        { text: 'Karachi · Pakistan', href: '' },
        { text: 'servd@gsfoods.pk', href: 'mailto:servd@gsfoods.pk' },
        { text: 'About servd', href: '/about' },
        { text: 'Contact', href: '/contact' },
        { text: 'Press', href: '/press' },
        { text: 'Privacy', href: '/privacy' },
        { text: 'Terms', href: '/terms' },
      ],
      copyright: '© {year} GS Foods. All rights reserved.',
      tagline: 'Made in Karachi. Cooked in Karachi. For Karachi.',
      accent: '',
    },
  },

  // ─── servd:feedback ──────────────────────────────────────────────────────
  // Words only until marketing's icons arrive (owner, 2026-10-10): every icon
  // is an optional image beside its word. No emoji.
  {
    variant: 'servd.feedback',
    label: 'servd feedback button',
    group: 'servd',
    description: 'The floating Feedback button and its sheet: recommend (NPS), rate (CSAT) or an open note. Shows on every page except sign-in, forms and ordering screens, and hides for a while after someone sends feedback.',
    icon: 'FB',
    pages: ['servd:feedback'],
    summaryKey: 'menuTitle',
    fields: [
      { key: 'triggerLabel', label: 'Button label', kind: 'text', hint: 'Shown on the button from tablet width; phones show the speech-bubble icon only.' },
      { key: 'triggerAriaLabel', label: 'Button name for screen readers', kind: 'text', hint: 'Empty = the button label.' },
      { key: 'menuTitle', label: 'Sheet title', kind: 'text' },
      { key: 'menuSub', label: 'Sheet sub-title', kind: 'textarea', hint: 'Empty = none.' },
      { key: 'modes', label: 'Choices', kind: 'list', itemLabel: 'Choice', max: 3,
        hint: 'The three kinds of feedback, in the order shown. Each kind once; leave one out to stop asking it.',
        item: [
          { key: 'mode', label: 'Kind', kind: 'select', options: [
            { value: 'nps', label: 'Recommend (0–10)' },
            { value: 'csat', label: 'Rate the experience (five ratings)' },
            { value: 'open', label: 'Open note' },
          ] },
          { key: 'label', label: 'Title', kind: 'text' },
          { key: 'sub', label: 'Small line', kind: 'text', hint: 'Empty = none.' },
          { key: 'icon', label: 'Icon', kind: 'image', hint: 'Optional, shown left of the title at 28px. Empty = words only.' },
        ] },
      { key: 'npsQuestion', label: 'Recommend: question', kind: 'text' },
      { key: 'npsLow', label: 'Recommend: word under 0', kind: 'text', hint: 'Empty = none.' },
      { key: 'npsHigh', label: 'Recommend: word under 10', kind: 'text', hint: 'Empty = none.' },
      { key: 'npsPlaceholder', label: 'Recommend: comment placeholder', kind: 'text', hint: 'Before a score, and after 7–10. Empty = none.' },
      { key: 'npsPlaceholderLow', label: 'Recommend: comment placeholder after 0–6', kind: 'text', hint: 'Empty = none.' },
      { key: 'csatQuestion', label: 'Rate: question', kind: 'text' },
      { key: 'csatRatings', label: 'Rate: ratings', kind: 'list', itemLabel: 'Rating', max: 5,
        hint: 'Always five, worst to best — the score is the position',
        item: [
          { key: 'label', label: 'Word', kind: 'text' },
          { key: 'icon', label: 'Icon', kind: 'image', hint: 'Optional, shown above the word at 32px. Empty = the word only.' },
        ] },
      { key: 'csatPlaceholder', label: 'Rate: comment placeholder', kind: 'text', hint: 'Empty = none.' },
      { key: 'openTitle', label: 'Open note: title', kind: 'text' },
      { key: 'openSub', label: 'Open note: sub-title', kind: 'textarea', hint: 'Empty = none.' },
      { key: 'openPlaceholder', label: 'Open note: placeholder', kind: 'text', hint: 'Empty = none.' },
      { key: 'backLabel', label: 'Back button', kind: 'text' },
      { key: 'sendLabel', label: 'Send button', kind: 'text' },
      { key: 'sendingLabel', label: 'Send button while sending', kind: 'text' },
      { key: 'doneIcon', label: 'Thank-you icon', kind: 'image', hint: 'Optional, shown above the title at 40px. Empty = none.' },
      { key: 'doneTitle', label: 'Thank-you title', kind: 'text' },
      { key: 'doneBody', label: 'Thank-you text', kind: 'textarea', hint: 'Empty = none.' },
      { key: 'doneLabel', label: 'Thank-you button', kind: 'text' },
      { key: 'cooldownDays', label: 'Days hidden after someone sends feedback', kind: 'number', min: 0, max: 365, step: 1,
        hint: 'On that visitor’s device, so they are not asked again straight away. 0 = never hidden.' },
    ],
    // Today's copy, verbatim — in feedbackDefaults.ts (see there for why).
    defaults: FEEDBACK_DEFAULTS,
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
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: `Empty = none. ${BOOKABLE_HINT}` },
      { key: 'title', label: 'Title', kind: 'text', hint: BOOKABLE_HINT },
      { key: 'titleAccent', label: 'Title second line (italic)', kind: 'text', hint: `Empty = none. ${BOOKABLE_HINT}` },
      { key: 'body', label: 'Intro', kind: 'textarea', hint: `Empty = none. ${BOOKABLE_HINT}` },
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

  // ─── servd:about, servd:faq ───────────────────────────────────────────────
  {
    variant: 'servd.aboutIntro',
    label: 'servd about (what is servd + kitchens table)',
    group: 'servd',
    description: 'An H1, a short factual answer to “what is servd” (the paragraph search engines and AI tools quote) and a table of the kitchens, read live from the brand records.',
    icon: 'AB',
    pages: ['servd:about', 'servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: 'Empty = none.' },
      { key: 'heading', label: 'Heading (the page’s H1)', kind: 'text' },
      { key: 'intro', label: 'Answer', kind: 'textarea', rows: 5, hint: 'Two or three plain, factual sentences, answer first. {brands} = the live kitchen names (“Simmer, Stackd and Flipd”), {count} = how many.' },
      { key: 'showTable', label: 'Show the kitchens table', kind: 'toggle', hint: 'Cuisine, area, price range and hours come from Admin → Marketing → Brands. A missing value shows the dash below, never a guess.' },
      { key: 'tableHeading', label: 'Table heading', kind: 'text', hint: 'Empty = none.' },
      { key: 'colKitchen', label: 'Column: kitchen', kind: 'text' },
      { key: 'colCuisine', label: 'Column: cuisine', kind: 'text' },
      { key: 'colArea', label: 'Column: area', kind: 'text' },
      { key: 'colPrice', label: 'Column: price range', kind: 'text' },
      { key: 'colHours', label: 'Column: hours', kind: 'text' },
      { key: 'colOrder', label: 'Column: order', kind: 'text' },
      { key: 'orderText', label: 'Order link text', kind: 'text' },
      { key: 'emptyText', label: 'Shown when a value is not on file', kind: 'text' },
      { key: 'note', label: 'Note under the table', kind: 'textarea', hint: 'Empty = none.' },
    ],
    defaults: {
      eyebrow: 'About servd',
      heading: 'What is servd?',
      intro: 'servd is the online ordering platform of GS Foods, a restaurant group in Karachi, Pakistan. It brings {count} kitchens together in one place: {brands}. Pick a kitchen, see its menu with prices in PKR, and order for pickup, delivery or dining in, then pay with cash, card or Raast QR.',
      showTable: true,
      tableHeading: 'The kitchens on servd',
      colKitchen: 'Kitchen',
      colCuisine: 'Cuisine',
      colArea: 'Area',
      colPrice: 'Price range',
      colHours: 'Hours',
      colOrder: 'Order',
      orderText: 'Order',
      emptyText: '—',
      note: 'Prices are in Pakistani rupees (PKR). Hours are Karachi time.',
    },
  },
  {
    variant: 'servd.faq',
    label: 'servd FAQ',
    group: 'servd',
    description: 'Questions and answers that open on tap. The same text becomes the page’s FAQ structured data for Google.',
    icon: 'FQ',
    pages: ['servd:faq', 'servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text', hint: 'Empty = none.' },
      { key: 'items', label: 'Questions', kind: 'list', itemLabel: 'Question', max: 40,
        hint: 'The starting answers are drafts: check each against how servd really works before publishing. A question with no answer is left out.',
        item: [
          { key: 'question', label: 'Question', kind: 'text' },
          { key: 'answer', label: 'Answer', kind: 'textarea', rows: 4, hint: 'Plain text; a new line is a line break. Keep it short and factual: search engines and AI tools quote it as written.' },
        ] },
      { key: 'openFirst', label: 'Open the first question', kind: 'toggle' },
    ],
    defaults: {
      heading: '',
      items: FAQ_DEFAULTS,
      openFirst: false,
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
      // The factual intro on each brand's booking page (/reserve/<brand>),
      // read by app/reserve/[slug]/page.tsx (SEO round 1).
      { key: 'introAddress', label: 'Booking page intro: address sentence', kind: 'text', hint: '{address} = the brand’s street, area and city. Shown only when a street is on file. Empty = none.' },
      { key: 'introPhone', label: 'Booking page intro: phone sentence', kind: 'text', hint: '{phone} = the brand’s phone. Shown only when a real number is on file. Empty = none.' },
      { key: 'introBooking', label: 'Booking page intro: how booking works', kind: 'textarea', hint: '{max} = the largest party the booking form offers. Empty = none.' },
    ],
    defaults: {
      introAddress: 'The address is {address}.',
      introPhone: 'Phone {phone}.',
      introBooking: 'Book a table online for 1 to {max} people: choose a date and party size, then a time. You get a link to confirm or cancel your booking straight after.',
      cardCta: 'Book at {brand} →',
      pillFallback: 'Dine-in',
      emptyText: 'No brands are accepting reservations right now.',
      emptyCta: { text: 'Browse all kitchens', href: '/#kitchens' },
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
  { slug: 'servd:feedback', sections: [{ variant: 'servd.feedback' }] },
  { slug: 'servd:waitlist', sections: [{ variant: 'servd.waitlistSignup' }] },
  {
    slug: 'servd:press',
    sections: [{ variant: 'servd.pageHeader' }, { variant: 'servd.pressCards' }],
  },
  {
    slug: 'servd:about',
    sections: [{ variant: 'servd.aboutIntro' }, { variant: 'servd.howItWorks' }],
  },
  {
    slug: 'servd:faq',
    sections: [
      { variant: 'servd.pageHeader', fields: {
        eyebrow: 'FAQ',
        title: 'Questions,',
        titleAccent: 'answered.',
        body: 'Ordering, delivery, payment, Insiders rewards, reservations and refunds on servd.',
        tight: true,
      } },
      { variant: 'servd.faq' },
    ],
  },
  {
    slug: 'servd:reserve',
    sections: [
      // {bookable} = the kitchens that take bookings (live), so with one
      // kitchen it reads "Book a table at Simmer." — matching the page title —
      // instead of "Pick the kitchen." over a single card.
      { variant: 'servd.pageHeader', fields: {
        eyebrow: 'Reservations',
        title: 'Book a table',
        titleAccent: 'at {bookable}.',
        body: 'We hold the room for you — choose a date, your party size and a time.',
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
