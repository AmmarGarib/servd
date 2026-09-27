// One voice per kitchen, from the empty bag to the curtain call.
//
// Every customer-facing line on the ordering climax (empty bag, add-to-cart
// toast, checkout CTA, the "that's a wrap" cut, closed-kitchen scene, login
// kicker, tracker acts) comes from here, so the four registers never drift:
//
//   servd  — the playful hub voice, lowercase, a little cheeky.
//   stackd — a lowercase café + market: sandwiches, pastries, mocktails,
//            packaging as the vessel. Never burgers.
//   Flipd  — the burger diner by the padel court: flat-top, rail, tickets.
//   simmer — plated evening service. Lowercase, calm, never an "!".
//
// Brand names inside these strings are already in their display form
// (formatBrandName rules), so callers can render them as they are.

export type VoiceBrand = 'servd' | 'simmer' | 'stackd' | 'flipd'

export function voiceBrand(slug?: string | null): VoiceBrand {
  const s = (slug ?? '').trim().toLowerCase()
  if (s === 'simmer' || s === 'stackd' || s === 'flipd') return s
  // Legacy stax paths redirect to stackd; treat them as the same kitchen.
  if (s === 'stax') return 'stackd'
  return 'servd'
}

export interface VoiceLines {
  emptyBag: { title: string; body: string; cta: string }
  added: string                          // toast after add-to-cart
  placeCta: string; placing: string      // checkout CTA label + busy label
  wrapKicker: string; wrapTitle: string  // order-placed cut
  closed: { title: string; body: string; menuCta: string; reserveCta: string }  // ordering unavailable
  loginKicker: string                    // one line on the brand-aware login
}

const LINES: Record<VoiceBrand, VoiceLines> = {
  servd: {
    emptyBag: {
      title: 'the bag’s empty.',
      body: 'nobody’s ordered yet. go pick a kitchen.',
      cta: 'pick a kitchen',
    },
    added: 'in the bag.',
    placeCta: 'place order',
    placing: 'sending it…',
    wrapKicker: 'that’s a wrap',
    wrapTitle: 'order’s in.',
    closed: {
      title: 'this kitchen’s not open online yet.',
      body: 'the menu’s up and the crowd’s warming up. check back soon, or pick another kitchen.',
      menuCta: 'see the menu',
      reserveCta: 'book a table',
    },
    loginKicker: 'backstage pass.',
  },
  stackd: {
    emptyBag: {
      title: 'nothing wrapped yet.',
      body: 'the pastry case is full and the chiller’s stocked. pick something and we’ll wrap it.',
      cta: 'see the counter',
    },
    added: 'wrapped.',
    placeCta: 'seal the bag',
    placing: 'sealing it…',
    wrapKicker: 'that’s a wrap',
    wrapTitle: 'it’s being wrapped.',
    closed: {
      title: 'the counter’s closed online.',
      body: 'the pastry case is full and the chiller’s stocked. order at the counter for now, or save yourself a seat.',
      menuCta: 'see the counter',
      reserveCta: 'save a seat',
    },
    loginKicker: 'back to the counter.',
  },
  flipd: {
    emptyBag: {
      title: 'the flat-top’s waiting.',
      body: 'nothing on the rail yet. pick a burger and we’ll fire it.',
      cta: 'see the menu',
    },
    added: 'on the rail.',
    placeCta: 'send it to the flat-top',
    placing: 'firing it…',
    wrapKicker: 'that’s a wrap',
    wrapTitle: 'ticket’s on the rail.',
    closed: {
      title: 'the flat-top’s cold online.',
      body: 'we’re not taking orders here yet. the menu’s up and the court-side tables are open.',
      menuCta: 'see the menu',
      reserveCta: 'grab a table',
    },
    loginKicker: 'one step from the flat-top.',
  },
  simmer: {
    emptyBag: {
      title: 'the table’s set. nothing on it yet.',
      body: 'the card is printed and the pass is warm. choose a plate when you are ready.',
      cta: 'see tonight’s card',
    },
    added: 'noted.',
    placeCta: 'send it down',
    placing: 'sending it down…',
    wrapKicker: 'noted',
    wrapTitle: 'the pass is warm.',
    closed: {
      title: 'tableside ordering opens soon.',
      body: 'your server takes the order from the printed card. reservations are open.',
      menuCta: 'see tonight’s card',
      reserveCta: 'reserve a table',
    },
    loginKicker: 'a moment, then your table.',
  },
}

export function voice(slug?: string | null): VoiceLines {
  return LINES[voiceBrand(slug)]
}

// ── Tracker: the order as a five-act film ──────────────────────────────────

type StoryStatus = 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled' | 'refunded'

const ACTS: Record<StoryStatus, string> = {
  received:  'act one',
  confirmed: 'act two',
  preparing: 'act three',
  ready:     'act four',
  completed: 'curtain call',
  cancelled: 'intermission',
  refunded:  'intermission',
}

type Beat = { headline: string; sub: string }

const STORY: Record<VoiceBrand, Record<StoryStatus, Beat>> = {
  servd: {
    received:  { headline: 'order’s in.',          sub: 'the kitchen’s reading your ticket now.' },
    confirmed: { headline: 'the kitchen said yes.',     sub: 'your order’s lined up for the pass.' },
    preparing: { headline: 'in the kitchen.',           sub: 'pans are hot and your order’s on.' },
    ready:     { headline: 'it’s ready.',          sub: 'bagged and waiting at the pass.' },
    completed: { headline: 'that’s a wrap.',       sub: 'hope it hit the spot. the crowd will be here next time.' },
    cancelled: { headline: 'this one’s off.',      sub: 'the order was cancelled. questions? the kitchen can help.' },
    refunded:  { headline: 'refund on its way.',        sub: 'the order was refunded. it can take a few days to land.' },
  },
  stackd: {
    received:  { headline: 'on the counter.',           sub: 'the barista’s got your ticket.' },
    confirmed: { headline: 'confirmed at the counter.', sub: 'you’re next in line for the griddle.' },
    preparing: { headline: 'on the griddle, then into the wrap.', sub: 'made here, then packed in its own vessel.' },
    ready:     { headline: 'wrapped and ready.',        sub: 'sealed and waiting at the counter.' },
    completed: { headline: 'that’s a wrap.',       sub: 'hope the wrap held up. see you at the counter.' },
    cancelled: { headline: 'this one’s unwrapped.', sub: 'the order was cancelled. the counter can help with questions.' },
    refunded:  { headline: 'refund on its way.',        sub: 'the order was refunded. it can take a few days to land.' },
  },
  flipd: {
    received:  { headline: 'ticket’s on the rail.', sub: 'the kitchen’s reading it now.' },
    confirmed: { headline: 'fired.',                    sub: 'the kitchen’s got it. patties are next.' },
    preparing: { headline: 'on the flat-top.',          sub: 'smashed and seasoned. salt and pepper, nothing else.' },
    ready:     { headline: 'order up.',                 sub: 'bagged hot and waiting at the pass.' },
    completed: { headline: 'that’s a wrap.',       sub: 'same burger, every time. see you after the next match.' },
    cancelled: { headline: 'ticket pulled.',            sub: 'the order was cancelled. the kitchen can help with questions.' },
    refunded:  { headline: 'refund on its way.',        sub: 'the order was refunded. it can take a few days to land.' },
  },
  simmer: {
    received:  { headline: 'noted.',                    sub: 'your order is with the pass.' },
    confirmed: { headline: 'confirmed.',                sub: 'the kitchen has your order.' },
    preparing: { headline: 'at the pass.',              sub: 'your plates are being finished.' },
    ready:     { headline: 'on its way to your table.', sub: 'the runner has your plates.' },
    completed: { headline: 'the table is cleared.',     sub: 'thank you for the evening.' },
    cancelled: { headline: 'this order was withdrawn.', sub: 'your server can help at the table.' },
    refunded:  { headline: 'a refund is on its way.',   sub: 'it can take a few days to arrive.' },
  },
}

function storyStatus(status: string): StoryStatus {
  return (Object.prototype.hasOwnProperty.call(ACTS, status) ? status : 'received') as StoryStatus
}

/** Tracker copy per status, with an act label, e.g. { act: 'act two', headline: 'on the flat-top.', sub: '…' } */
export function statusStory(slug: string | null | undefined, status: string): { act: string; headline: string; sub: string } {
  const s = storyStatus(status)
  const beat = STORY[voiceBrand(slug)][s]
  return { act: ACTS[s], headline: beat.headline, sub: beat.sub }
}
