// brand sections — catalogue (data only: no React, no imports from renderers).
// See ../README.md for the contract.
//
// The chrome (header + footer) and the About / Visit / Menu pages every brand
// microsite shares, plus the home page for brands without a bespoke design.
//
// Conventions (resolved in ./util.ts):
//   {{brand.name}} {{brand.slug}} {{brand.type}} in text → the live brand.
//   Link tokens @home @menu @about @visit @visitpage @order @book @location
//   @whatsapp @email @phone → the live brand's pages / contact; a link whose
//   target is missing (no reservations, no WhatsApp set) is hidden. Links
//   follow the host: /menu on the brand's own domain, /brand/<slug>/menu on
//   servd, and servd pages (ordering, booking) absolute on a brand domain.
//   A text field defaulting to '' means "use the live value" (see its hint).
import type { FieldSpec, PageDefault, SectionSpec } from '../types'

const GROUP = 'Brand pages'
const TOKENS = 'Tokens: @home @menu @about @visit (Maps pin) @visitpage (Visit page) @order @book @location @whatsapp @email @phone. {{brand.name}} works in text.'
/** Alt text: what a photo shows. Empty = the image is decoration only. */
const ALT_HINT = 'Describe the photo for Google and screen readers. Empty = decoration only (drawn as a background)'
/** Text sections paint servd bone unless a colour is picked (the brand pages
 *  sit on the brand's dark field, where servd's ink would not read). */
const BONE_HINT = 'Empty = servd bone. Pick a light colour: the text is servd ink'
/** Content sections: any brand page (home, about, visit, menu, added pages). */
const BRAND_PAGES = ['brand:*', 'brand:*:*']

const linkItem: FieldSpec[] = [
  { key: 'text', label: 'Label', kind: 'text' },
  { key: 'href', label: 'Link', kind: 'text', hint: TOKENS },
]

// ─── Header ────────────────────────────────────────────────────────────────

const header: SectionSpec = {
  variant: 'brand.header',
  label: 'Brand header',
  group: GROUP,
  description: 'The brand site’s top bar: logo, links and the Order button. The look follows the brand.',
  icon: 'HD',
  pages: ['brand:*:header'],
  summaryKey: 'name',
  fields: [
    { key: 'name', label: 'Brand name', kind: 'text', hint: 'Empty = the brand’s name from Brands' },
    { key: 'logo', label: 'Logo (round badge)', kind: 'image', hint: 'Empty = the logo uploaded in Brands, else the name’s first letter' },
    { key: 'badge', label: 'Badge (Flipd)', kind: 'image', hint: 'Flipd shows its die-cut badge instead of logo + name. Empty = the wordmark upload, else the bundled badge' },
    { key: 'links', label: 'Links', kind: 'list', itemLabel: 'Link', max: 8, item: linkItem },
    { key: 'order', label: 'Order button', kind: 'link', hint: TOKENS },
    { key: 'servdLink', label: '“on servd” link', kind: 'link', hint: 'Shown on brands without the pill bar. Empty label hides it' },
  ],
  defaults: {
    name: '',
    logo: '',
    badge: '',
    links: [
      { text: 'Home', href: '@home' },
      { text: 'Menu', href: '@menu' },
      { text: 'Story', href: '@about' },
      { text: 'Book', href: '@book' },
      { text: 'Visit', href: '@visit' },
    ],
    order: { text: 'Order', href: '@order' },
    servdLink: { text: 'on servd', href: '/home' },
  },
}

/** The carded-pill brands keep the bar lean: Menu, Book, Visit. */
const LEAN_HEADER_LINKS = [
  { text: 'Menu', href: '@menu' },
  { text: 'Book', href: '@book' },
  { text: 'Visit', href: '@visit' },
]

// ─── Footer ────────────────────────────────────────────────────────────────

const footer: SectionSpec = {
  variant: 'brand.footer',
  label: 'Brand footer',
  group: GROUP,
  description: 'Closing call to action, the brand’s links and socials, and the servd sign-off.',
  icon: 'FT',
  pages: ['brand:*:footer'],
  summaryKey: 'ctaHeadline',
  fields: [
    { key: 'ctaEyebrow', label: 'CTA eyebrow', kind: 'text' },
    { key: 'ctaHeadline', label: 'CTA headline', kind: 'text' },
    { key: 'ctaAccent', label: 'CTA headline (accent part)', kind: 'text' },
    { key: 'ctaButton', label: 'CTA button', kind: 'link', hint: TOKENS },
    { key: 'name', label: 'Brand name', kind: 'text', hint: 'Empty = the brand’s name from Brands' },
    { key: 'tagline', label: 'Tagline', kind: 'textarea', hint: 'Empty = the brand’s description from Brands' },
    { key: 'socials', label: 'Socials', kind: 'list', itemLabel: 'Social', max: 8, item: linkItem },
    { key: 'linksHeading', label: 'Links heading', kind: 'text', hint: 'Empty = the brand’s name' },
    { key: 'links', label: 'Links', kind: 'list', itemLabel: 'Link', max: 8, item: linkItem },
    { key: 'poweredHeading', label: '“Powered by” heading', kind: 'text' },
    { key: 'servdLink', label: 'servd wordmark link', kind: 'link' },
    { key: 'servdTagline', label: 'servd line', kind: 'text' },
    { key: 'allKitchens', label: 'All kitchens link', kind: 'link', hint: 'Empty label hides it' },
    { key: 'legal', label: 'Legal name', kind: 'text', hint: 'After “© year Brand ·”' },
    { key: 'backLink', label: 'Back to servd link', kind: 'link', hint: 'Empty label hides it' },
  ],
  defaults: {
    ctaEyebrow: '{{brand.name}} · ready when you are',
    ctaHeadline: 'Hungry?',
    ctaAccent: "Let's eat.",
    ctaButton: { text: 'Order from {{brand.name}} →', href: '@order' },
    name: '',
    tagline: '',
    socials: [
      { text: 'WhatsApp', href: '@whatsapp' },
      { text: 'Email', href: '@email' },
    ],
    linksHeading: '',
    links: [
      { text: 'Menu', href: '@menu' },
      { text: 'Our story', href: '@about' },
      // The site's own Visit page (the header's "Visit" goes to the Maps pin).
      { text: 'Find us', href: '@visitpage' },
      // Hidden when the brand takes no reservations.
      { text: 'Book a table', href: '@book' },
      { text: 'Order online', href: '@order' },
    ],
    poweredHeading: 'Powered by',
    servdLink: { text: 'servd', href: '/home' },
    servdTagline: 'One platform. Every kitchen.',
    allKitchens: { text: 'See all kitchens', href: '/home#kitchens' },
    legal: 'GS Foods Pvt. Ltd.',
    backLink: { text: 'back to servd', href: '/home' },
  },
}

// ─── About ─────────────────────────────────────────────────────────────────

const aboutHero: SectionSpec = {
  variant: 'brand.aboutHero',
  label: 'Story hero',
  group: GROUP,
  description: 'Centred eyebrow, headline and the brand’s story.',
  icon: 'SH',
  pages: BRAND_PAGES,
  summaryKey: 'eyebrow',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'headline', label: 'Headline', kind: 'text', hint: 'Empty = the brand’s tagline' },
    { key: 'body', label: 'Story', kind: 'textarea', rows: 5, hint: 'Empty = the brand’s long story' },
    { key: 'eyebrowColor', label: 'Eyebrow colour', kind: 'color', hint: 'Empty = servd green' },
    { key: 'bg', label: 'Background', kind: 'color', hint: BONE_HINT },
  ],
  defaults: { eyebrow: 'About {{brand.name}}', headline: '', body: '', eyebrowColor: '', bg: '' },
}

const pillars: SectionSpec = {
  variant: 'brand.pillars',
  label: 'Pillars',
  group: GROUP,
  description: 'Stacked headings with a paragraph each.',
  icon: 'PL',
  pages: BRAND_PAGES,
  fields: [
    { key: 'items', label: 'Pillars', kind: 'list', itemLabel: 'Pillar', max: 8, item: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'body', label: 'Body', kind: 'textarea' },
    ] },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = servd surface' },
  ],
  defaults: {
    items: [
      { heading: 'Made in our own kitchen', body: '{{brand.name}} is cooked in-house, start to finish — our recipes, our team, our standards. Nothing about your meal is outsourced or white-labelled.' },
      { heading: 'Order in seconds', body: 'Browse the menu, build your order, and check out in one place. The kitchen gets your ticket the moment you tap order — and you can track it the whole way.' },
      { heading: 'One account, every kitchen', body: 'Loyalty points, wallet credit, and saved addresses follow you across every kitchen on servd — same account, same payment, same tracker, whichever brand you are craving.' },
    ],
    bg: '',
  },
}

const imageBreak: SectionSpec = {
  variant: 'brand.imageBreak',
  label: 'Image break',
  group: GROUP,
  description: 'A full-width band of the brand colour and its image.',
  icon: 'IB',
  pages: BRAND_PAGES,
  summaryKey: 'image',
  fields: [
    { key: 'image', label: 'Image', kind: 'image', hint: 'Empty = the brand’s own hero image, if it has one' },
    { key: 'alt', label: 'Image description (alt text)', kind: 'text', hint: ALT_HINT },
    { key: 'bg', label: 'Colour', kind: 'color', hint: 'Empty = the brand colour' },
  ],
  defaults: { image: '', alt: '', bg: '' },
}

const ctaBand: SectionSpec = {
  variant: 'brand.ctaBand',
  label: 'Call to action',
  group: GROUP,
  description: 'Centred headline, a line, and up to two buttons.',
  icon: 'CTA',
  pages: BRAND_PAGES,
  summaryKey: 'headline',
  fields: [
    { key: 'headline', label: 'Headline', kind: 'text' },
    { key: 'body', label: 'Line', kind: 'text' },
    { key: 'primary', label: 'Main button', kind: 'link', hint: TOKENS },
    { key: 'secondary', label: 'Second button', kind: 'link', hint: 'Empty label hides it' },
    { key: 'bg', label: 'Background', kind: 'color', hint: BONE_HINT },
  ],
  defaults: {
    headline: 'Want to taste it?',
    body: 'The proof is in the food.',
    primary: { text: 'Order from {{brand.name}} →', href: '@order' },
    secondary: { text: 'See the menu', href: '@menu' },
    bg: '',
  },
}

// ─── Visit ─────────────────────────────────────────────────────────────────

const pageHeader: SectionSpec = {
  variant: 'brand.pageHeader',
  label: 'Page header',
  group: GROUP,
  description: 'Eyebrow, headline, one line and an optional button.',
  icon: 'PH',
  pages: BRAND_PAGES,
  summaryKey: 'headline',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'headline', label: 'Headline', kind: 'text' },
    { key: 'body', label: 'Line', kind: 'textarea', hint: 'Empty = “We’re a <service type> kitchen — order in, walk in, or grab to go.”' },
    { key: 'cta', label: 'Button', kind: 'link', hint: 'Empty label hides it. ' + TOKENS },
    { key: 'bg', label: 'Background', kind: 'color', hint: BONE_HINT },
  ],
  defaults: {
    eyebrow: 'Visit',
    headline: 'Find {{brand.name}}.',
    body: '',
    cta: { text: '', href: '' },
    bg: '',
  },
}

const visitInfo: SectionSpec = {
  variant: 'brand.visitInfo',
  label: 'Address & hours',
  group: GROUP,
  description: 'The kitchen’s address, phone, email and map, other kitchens, and opening hours — all live from Brands and Locations.',
  icon: 'AH',
  pages: BRAND_PAGES,
  summaryKey: 'addressHeading',
  fields: [
    { key: 'addressHeading', label: 'Address heading', kind: 'text' },
    { key: 'noAddress', label: 'No-address text', kind: 'text' },
    { key: 'alsoAtHeading', label: 'Other kitchens heading', kind: 'text' },
    { key: 'directionsLabel', label: 'Directions link label', kind: 'text' },
    { key: 'hoursHeading', label: 'Hours heading', kind: 'text' },
    { key: 'hoursNote', label: 'Hours note', kind: 'textarea' },
    { key: 'noHours', label: 'No-hours text', kind: 'text' },
    { key: 'locationLink', label: 'Location page link', kind: 'link', hint: 'Shown under the contact details. Empty label hides it. ' + TOKENS },
    { key: 'cta', label: 'Button', kind: 'link', hint: 'Empty label hides it. ' + TOKENS },
    { key: 'linkColor', label: 'Link colour', kind: 'color', hint: 'Empty = servd green' },
    { key: 'bg', label: 'Background', kind: 'color', hint: BONE_HINT },
  ],
  defaults: {
    addressHeading: 'Our address',
    noAddress: 'Address not set — check our socials for directions.',
    alsoAtHeading: 'Also at',
    directionsLabel: 'Directions',
    hoursHeading: 'Opening hours',
    hoursNote: 'Times shown for delivery and pickup; dine-in may differ. We’ll show live availability when you start an order.',
    noHours: 'Hours not configured yet — start an order to see live availability.',
    locationLink: { text: 'Location page', href: '@location' },
    cta: { text: 'Order Now →', href: '@order' },
    linkColor: '',
    bg: '',
  },
}

// ─── FAQ ───────────────────────────────────────────────────────────────────
//
// Questions and answers shown on the page. The Visit page's FAQPage
// structured data is built from these same fields (app/brand/[slug]/visit),
// so search engines are only ever told what a visitor can read.

const FAQ_ALWAYS = 'always'

/** Today's questions, every brand. {{brand.place}} = the live area and city. */
const FAQ_ITEMS = [
  { question: 'Where is {{brand.name}} located?', answer: '{{brand.name}} is in {{brand.place}}.', link: { text: '', href: '' }, show: FAQ_ALWAYS },
  { question: 'Does {{brand.name}} take reservations?', answer: 'Yes — tables can be booked online.', link: { text: 'Book a table', href: '@book' }, show: 'reservations' },
  { question: 'Does {{brand.name}} take reservations?', answer: '{{brand.name}} is walk-in friendly — no booking needed. For delivery and pickup, order ahead.', link: { text: 'Start an order', href: '@order' }, show: 'no-reservations' },
  { question: 'Is the food halal?', answer: 'All {{brand.name}} kitchens serve halal-only meat. No pork, no alcohol on the cooking line.', link: { text: '', href: '' }, show: FAQ_ALWAYS },
  { question: 'Does {{brand.name}} deliver?', answer: 'You can order online for delivery or pickup, where available.', link: { text: 'Start an order', href: '@order' }, show: FAQ_ALWAYS },
  { question: 'What’s the dress code?', answer: 'Smart casual works everywhere. No formal requirement.', link: { text: '', href: '' }, show: FAQ_ALWAYS },
  { question: 'Is there parking?', answer: 'Street parking is available around the venue. We recommend arriving 10 minutes early on weekends.', link: { text: '', href: '' }, show: FAQ_ALWAYS },
]

/** Simmer's dress-code answer is its own (a dimly-lit room). */
const SIMMER_FAQ_ITEMS = FAQ_ITEMS.map((it) => it.question === 'What’s the dress code?'
  ? { ...it, answer: 'Smart casual works everywhere. {{brand.name}} is a dimly-lit room; the dressier you are the more it suits the space.' }
  : it)

const faq: SectionSpec = {
  variant: 'brand.faq',
  label: 'Questions & answers',
  group: GROUP,
  description: 'A heading and a list of questions with their answers. On the Visit page they are also given to search engines as the page’s FAQ.',
  icon: 'QA',
  pages: BRAND_PAGES,
  summaryKey: 'heading',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'heading', label: 'Heading', kind: 'text' },
    { key: 'items', label: 'Questions', kind: 'list', itemLabel: 'Question', max: 16, item: [
      { key: 'question', label: 'Question', kind: 'text' },
      { key: 'answer', label: 'Answer', kind: 'textarea', rows: 3 },
      { key: 'link', label: 'Link after the answer', kind: 'link', hint: 'Empty label hides it. ' + TOKENS },
      { key: 'show', label: 'Show', kind: 'select', options: [
        { value: 'always', label: 'Always' },
        { value: 'reservations', label: 'Only when the brand takes reservations' },
        { value: 'no-reservations', label: 'Only when it does not' },
      ] },
    ] },
    { key: 'bg', label: 'Background', kind: 'color', hint: BONE_HINT },
  ],
  defaults: {
    eyebrow: 'Good to know',
    heading: 'Before you come.',
    items: FAQ_ITEMS,
    bg: '',
  },
}

// ─── Menu ──────────────────────────────────────────────────────────────────

const menu: SectionSpec = {
  variant: 'brand.menu',
  label: 'Menu',
  group: GROUP,
  description: 'The brand’s live menu as cards, with a category bar. Items, prices and photos come from the menu itself.',
  icon: 'MN',
  pages: BRAND_PAGES,
  summaryKey: 'headline',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'headline', label: 'Headline', kind: 'text' },
    { key: 'body', label: 'Line', kind: 'textarea' },
    { key: 'cta', label: 'Button', kind: 'link', hint: 'Empty label hides it. ' + TOKENS },
    { key: 'soldOutLabel', label: 'Sold-out label', kind: 'text' },
    { key: 'emptyText', label: 'No-menu text', kind: 'text' },
    { key: 'emptyCta', label: 'No-menu button', kind: 'link' },
    { key: 'bottomHeadline', label: 'Closing headline', kind: 'text' },
    { key: 'bottomBody', label: 'Closing line', kind: 'text' },
    { key: 'bottomCta', label: 'Closing button', kind: 'link' },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = white' },
    { key: 'bottomBg', label: 'Closing background', kind: 'color', hint: 'Empty = servd surface' },
  ],
  defaults: {
    eyebrow: 'Menu',
    headline: 'Everything {{brand.name}} serves.',
    body: 'Browse the full menu. Tap Order to start a basket — your selection follows you into checkout.',
    cta: { text: 'Start ordering →', href: '@order' },
    soldOutLabel: 'Sold out',
    emptyText: 'Menu’s not loaded yet — try the order page.',
    emptyCta: { text: 'Go to ordering', href: '@order' },
    bottomHeadline: 'Hungry yet?',
    bottomBody: 'Build your order in two taps.',
    bottomCta: { text: 'Start ordering →', href: '@order' },
    bg: '',
    bottomBg: '',
  },
}

// ─── Generic brand home (brands without a bespoke design) ──────────────────

const genericHero: SectionSpec = {
  variant: 'brand.genericHero',
  label: 'Brand hero',
  group: GROUP,
  description: 'Brand colour over its image: name, live open/closed badge, tagline, buttons, highlights and the week’s hours.',
  icon: 'BH',
  pages: BRAND_PAGES,
  summaryKey: 'eyebrow',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'name', label: 'Brand name', kind: 'text', hint: 'Empty = the brand’s name from Brands' },
    { key: 'tagline', label: 'Tagline', kind: 'text', hint: 'Empty = the brand’s tagline' },
    { key: 'description', label: 'Description', kind: 'textarea', hint: 'Empty = the brand’s description from Brands' },
    { key: 'primary', label: 'Main button', kind: 'link', hint: TOKENS },
    { key: 'secondary', label: 'Second button', kind: 'link', hint: 'Empty label hides it' },
    { key: 'highlights', label: 'Highlights', kind: 'list', itemLabel: 'Highlight', max: 8,
      item: [{ key: 'text', label: 'Text', kind: 'text' }], },
    { key: 'image', label: 'Background image', kind: 'image', hint: 'Empty = the brand’s own hero image, if it has one' },
    { key: 'imageAlt', label: 'Background image description (alt text)', kind: 'text', hint: ALT_HINT },
    { key: 'accent', label: 'Brand colour', kind: 'color', hint: 'Empty = the brand colour' },
    { key: 'showStatus', label: 'Show open/closed badge', kind: 'toggle' },
    { key: 'statusColor', label: 'Open colour', kind: 'color', hint: 'Empty = servd green' },
    { key: 'openLabel', label: '“Open Now” label', kind: 'text', hint: 'Empty = Open Now' },
    { key: 'closesLabel', label: '“Closes” label', kind: 'text', hint: 'Empty = Closes' },
    { key: 'closedLabel', label: '“Closed” label', kind: 'text', hint: 'Empty = Closed' },
    { key: 'opensLabel', label: '“Opens” label', kind: 'text', hint: 'Empty = Opens' },
    { key: 'hoursLabel', label: 'Hours label', kind: 'text' },
  ],
  defaults: {
    eyebrow: 'A servd kitchen · GS Foods · {{brand.type}}',
    name: '',
    tagline: '',
    description: '',
    primary: { text: 'Order from {{brand.name}} →', href: '@order' },
    secondary: { text: 'See full menu', href: '@menu' },
    highlights: [],
    image: '',
    imageAlt: '',
    accent: '',
    showStatus: true,
    statusColor: '',
    openLabel: '',
    closesLabel: '',
    closedLabel: '',
    opensLabel: '',
    hoursLabel: 'Hours (PKT)',
  },
}

const signatures: SectionSpec = {
  variant: 'brand.signatures',
  label: 'Signature dishes',
  group: GROUP,
  description: 'A row of dish cards with photo, price and a note.',
  icon: 'SD',
  pages: BRAND_PAGES,
  summaryKey: 'heading',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'heading', label: 'Heading', kind: 'text' },
    { key: 'items', label: 'Dishes', kind: 'list', itemLabel: 'Dish', max: 9, item: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'price', label: 'Price', kind: 'text' },
      { key: 'note', label: 'Note', kind: 'text' },
      { key: 'image', label: 'Photo', kind: 'image', hint: 'Empty = the brand colour with the dish’s initial' },
      { key: 'alt', label: 'Photo description (alt text)', kind: 'text', hint: 'E.g. the dish’s name and what is on the plate. ' + ALT_HINT },
    ] },
    { key: 'accent', label: 'Accent', kind: 'color', hint: 'Empty = the brand colour' },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = white' },
  ],
  defaults: {
    eyebrow: 'What we’re known for',
    heading: 'Signature dishes',
    items: [
      { name: 'House Favourite', price: '—', note: 'Our most-ordered dish.', image: '', alt: '' },
      { name: 'Chef’s Pick', price: '—', note: 'Try what the team eats.', image: '', alt: '' },
      { name: 'Crowd Pleaser', price: '—', note: 'Safe bet, big portions.', image: '', alt: '' },
    ],
    accent: '',
    bg: '',
  },
}

const story: SectionSpec = {
  variant: 'brand.story',
  label: 'Brand story',
  group: GROUP,
  description: 'Eyebrow, heading, the brand’s story and a closing line.',
  icon: 'ST',
  pages: BRAND_PAGES,
  summaryKey: 'heading',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'heading', label: 'Heading', kind: 'text' },
    { key: 'body', label: 'Story', kind: 'textarea', rows: 5, hint: 'Empty = the brand’s long story' },
    { key: 'note', label: 'Closing line', kind: 'text' },
    { key: 'accent', label: 'Accent', kind: 'color', hint: 'Empty = the brand colour' },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = off-white' },
  ],
  defaults: {
    eyebrow: 'The story',
    heading: 'Why {{brand.name}}?',
    body: '',
    note: 'Cooked fresh in our own kitchen — just food we’d be happy to serve a friend.',
    accent: '',
    bg: '',
  },
}

const reviews: SectionSpec = {
  variant: 'brand.reviews',
  label: 'Review cards',
  group: GROUP,
  description: 'A rating headline and five-star review cards.',
  icon: 'RV',
  pages: BRAND_PAGES,
  summaryKey: 'heading',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'headingAccent', label: 'Heading (accent part)', kind: 'text' },
    { key: 'heading', label: 'Heading', kind: 'text' },
    { key: 'items', label: 'Reviews', kind: 'list', itemLabel: 'Review', max: 9, item: [
      { key: 'text', label: 'Review', kind: 'textarea' },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'area', label: 'Area', kind: 'text' },
    ] },
    { key: 'accent', label: 'Accent', kind: 'color', hint: 'Empty = the brand colour' },
    { key: 'starColor', label: 'Star colour', kind: 'color', hint: 'Empty = amber' },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = white' },
  ],
  defaults: {
    eyebrow: 'From your neighbours',
    headingAccent: '4.8 stars',
    heading: 'from {{brand.name}} regulars',
    items: [
      { text: '"Direct from the kitchen — you can taste it. Hot, fresh, on time, every time."', name: 'A regular', area: 'Karachi' },
      { text: '"One menu, one checkout, no fuss. Exactly how ordering should feel."', name: 'A neighbour', area: 'Karachi' },
      { text: '"The team behind servd actually cooks the food. It shows."', name: 'A first-timer', area: 'Karachi' },
    ],
    accent: '',
    starColor: '',
    bg: '',
  },
}

const crossBrand: SectionSpec = {
  variant: 'brand.crossBrand',
  label: 'Other kitchens',
  group: GROUP,
  description: 'Cards for the company’s other brands (only brands of the same company).',
  icon: 'OK',
  pages: BRAND_PAGES,
  summaryKey: 'heading',
  fields: [
    { key: 'kicker', label: 'Eyebrow', kind: 'text' },
    { key: 'heading', label: 'Heading', kind: 'text' },
    { key: 'subtitle', label: 'Line', kind: 'textarea' },
    { key: 'allLink', label: 'All kitchens button', kind: 'link', hint: 'Empty label hides it' },
    { key: 'cardCta', label: 'Card call to action', kind: 'text', hint: '{name} = that card’s brand' },
    { key: 'accent', label: 'Accent', kind: 'color', hint: 'Empty = the brand colour' },
    { key: 'bg', label: 'Background', kind: 'color', hint: 'Empty = white' },
  ],
  defaults: {
    kicker: 'Other GS Foods kitchens',
    heading: 'Liked {{brand.name}}? Try one of these.',
    subtitle: 'Same operator, same standards. Different cuisine, different vibe — and you can pair them in one cart.',
    allLink: { text: 'See all kitchens →', href: '/home#kitchens' },
    cardCta: 'Visit {name} →',
    accent: '',
    bg: '',
  },
}

const bottomCta: SectionSpec = {
  variant: 'brand.bottomCta',
  label: 'First-order offer',
  group: GROUP,
  description: 'Promo band: eyebrow, offer headline, code and an order button.',
  icon: 'FO',
  pages: BRAND_PAGES,
  summaryKey: 'headlineAccent',
  fields: [
    { key: 'eyebrow', label: 'Eyebrow', kind: 'text' },
    { key: 'headline', label: 'Headline (before accent)', kind: 'text' },
    { key: 'headlineAccent', label: 'Headline (accent)', kind: 'text' },
    { key: 'headlineTail', label: 'Headline (after accent)', kind: 'text' },
    { key: 'bodyBefore', label: 'Line (before code)', kind: 'text' },
    { key: 'code', label: 'Promo code', kind: 'text', hint: 'Empty hides the code' },
    { key: 'bodyAfter', label: 'Line (after code)', kind: 'text' },
    { key: 'button', label: 'Button', kind: 'link', hint: TOKENS },
    { key: 'accent', label: 'Accent', kind: 'color', hint: 'Empty = the brand colour' },
  ],
  defaults: {
    eyebrow: 'New to {{brand.name}}?',
    headline: 'Get',
    headlineAccent: 'Rs. 200 off',
    headlineTail: 'your first order',
    bodyBefore: 'Use code',
    code: 'FRESH200',
    bodyAfter: 'at checkout. Free delivery over Rs. 1,500.',
    button: { text: 'Order from {{brand.name}} →', href: '@order' },
    accent: '',
  },
}

export const specs: SectionSpec[] = [
  header, footer,
  aboutHero, pillars, imageBreak, ctaBand,
  pageHeader, visitInfo, faq,
  menu,
  genericHero, signatures, story, reviews, crossBrand, bottomCta,
]

export const pages: PageDefault[] = [
  { slug: 'brand:*:header', sections: [{ variant: 'brand.header' }] },
  // The carded-pill brands keep the bar lean (the logo is "home", the story
  // lives in the footer).
  { slug: 'brand:simmer:header', sections: [{ variant: 'brand.header', fields: { links: LEAN_HEADER_LINKS } }] },
  { slug: 'brand:stackd:header', sections: [{ variant: 'brand.header', fields: { links: LEAN_HEADER_LINKS } }] },
  { slug: 'brand:flipd:header', sections: [{ variant: 'brand.header', fields: { links: LEAN_HEADER_LINKS } }] },
  { slug: 'brand:*:footer', sections: [{ variant: 'brand.footer' }] },
  { slug: 'brand:*:about', sections: [
    { variant: 'brand.aboutHero' },
    { variant: 'brand.pillars' },
    { variant: 'brand.imageBreak' },
    { variant: 'brand.ctaBand' },
  ] },
  { slug: 'brand:*:visit', sections: [
    { variant: 'brand.pageHeader' },
    { variant: 'brand.visitInfo' },
    { variant: 'brand.faq' },
  ] },
  { slug: 'brand:simmer:visit', sections: [
    { variant: 'brand.pageHeader' },
    { variant: 'brand.visitInfo' },
    { variant: 'brand.faq', fields: { items: SIMMER_FAQ_ITEMS } },
  ] },
  { slug: 'brand:*:menu', sections: [{ variant: 'brand.menu' }] },
  { slug: 'brand:*', sections: [
    { variant: 'brand.genericHero' },
    { variant: 'brand.signatures' },
    { variant: 'brand.story' },
    { variant: 'brand.reviews' },
    { variant: 'brand.crossBrand' },
    { variant: 'brand.bottomCta' },
  ] },
]
