// servd's FAQ — the ONE default list (catalog.ts reads it for the section's
// defaults; /llms-full.txt reads it for hosts whose servd:faq page has nothing
// published). DRAFT answers for the owner to confirm in Admin -> Storefront ->
// servd:faq: nothing here is a policy until the CEO publishes it.
//
// Data only (no React) so the catalogue and a route handler can both import it.

export interface FaqItem { question: string; answer: string }

export const FAQ_DEFAULTS: FaqItem[] = [
  {
    question: 'What is servd?',
    answer: 'servd is the online ordering platform of GS Foods, a restaurant group in Karachi, Pakistan. You pick a kitchen, see its menu with prices in PKR, and order from one place.',
  },
  {
    question: 'How do I order?',
    answer: 'Open servd.pk, choose a kitchen, add dishes to your basket and check out. You pick how you want your order (dine-in, pickup, curbside or delivery, depending on the kitchen) and pay at checkout.',
  },
  {
    question: 'Which kitchens deliver, and which take pickup?',
    answer: 'It depends on the kitchen. Flipd delivers. Stackd takes pickup and curbside orders. Simmer is a dining room, so orders are for people seated at its tables. The options for each kitchen are shown on its ordering page.',
  },
  {
    question: 'How much does delivery cost?',
    answer: 'The delivery fee and the area we deliver to are shown at checkout, before you pay.',
  },
  {
    question: 'How can I pay?',
    answer: 'servd takes Cash, Card and Raast QR. The payment choices for your order are shown at checkout. Prices are in Pakistani rupees (PKR).',
  },
  {
    question: 'What is Insiders?',
    answer: 'Insiders is servd\'s free rewards programme. Members earn rewards on their orders and hear first about limited drops and off-menu dishes. What you earn differs by kitchen. Join from servd.pk, or on WhatsApp.',
  },
  {
    question: 'Can I book a table?',
    answer: 'Yes, at the kitchens that take reservations. Open servd.pk/reserve, choose a kitchen, a date, your party size and a time.',
  },
  {
    question: 'What if something is wrong with my order, or I need a refund?',
    answer: 'Tell us as soon as you can and quote your order reference (the last 8 characters of your order number). We look into every report. Where a refund is due it goes back the way you paid.',
  },
  {
    question: 'How do I contact servd?',
    answer: 'Use the contact page at servd.pk/contact, or email servd@gsfoods.pk. Each kitchen\'s own page lists its phone, WhatsApp and address.',
  },
]

/** The FAQ items a section's fields hold: question + answer both present. */
export function faqItemsOf(items: unknown): FaqItem[] {
  if (!Array.isArray(items)) return []
  const out: FaqItem[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const q = (it as { question?: unknown }).question
    const a = (it as { answer?: unknown }).answer
    const question = typeof q === 'string' ? q.trim() : ''
    const answer = typeof a === 'string' ? a.trim() : ''
    if (question && answer) out.push({ question, answer })
  }
  return out
}
