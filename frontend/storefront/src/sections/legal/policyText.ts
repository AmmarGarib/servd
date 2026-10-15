// DRAFT wording for /privacy and /terms (SEO round 1, owner 2026-10-14).
//
// Drafted for the owner and a lawyer to review. Nothing here has been
// approved: both pages open with a "Draft — to be approved" note (a field the
// owner clears when the wording is signed off). Plain language, Pakistan
// context. Everything is a default of a section field — the owner edits it in
// Admin → Storefront → Pages (servd:privacy, servd:terms) and the CEO
// approves what goes live.
//
// Cookie names here are the ones the storefront really sets: `sv_vid`
// (lib/abVariant.ts), the `sv_consent` choice and the first-party `_asid`
// session id (lib/analytics.ts), and — only after the visitor accepts — the
// Google Analytics 4 cookies (`_ga`, `_ga_<id>`). If a name changes in code,
// change it here in the same piece of work.

export interface PolicySection { heading: string; body: string }

export const DRAFT_NOTE =
  'Draft — to be approved. This page is a working draft written for the owner and a lawyer to review. It is not final legal advice and may change before it is approved.'

export const PRIVACY_INTRO =
  'servd is the online ordering service of GS Foods Pvt. Ltd., a restaurant group in Karachi, Pakistan. This page explains what personal information we collect when you use servd.pk or one of our kitchen sites (Simmer, Stackd, Flipd), why we collect it, who sees it and what your choices are.'

export const PRIVACY_SECTIONS: PolicySection[] = [
  {
    heading: 'Who we are',
    body: 'servd.pk and the kitchen sites are run by GS Foods Pvt. Ltd., Karachi, Pakistan ("we", "us"). Each kitchen belongs to one of our operating companies; the company that cooks and delivers your order is the one that holds your order details.\nFor anything on this page, write to servd@gsfoods.pk or use the contact page at servd.pk/contact.',
  },
  {
    heading: 'What we collect',
    body: '- Your phone number. You use it to sign in: we send a one-time code by WhatsApp to check it is you.\n- Your name and email address, if you give them when you sign up, order, book a table or write to us.\n- Delivery addresses, and your location if you choose to share it, so we can price and route a delivery.\n- Your orders: what you ordered, when, from which kitchen, how you paid (cash, card or Raast QR), and the amount. We do not store your full card number; card payments go through the card machine or payment provider.\n- Table bookings and waitlist sign-ups: your name, phone, party size and time.\n- Messages you send us: the contact form, feedback and reviews, including the name and the phone or email you give us to reply.\n- Rewards: points and wallet balance in the Insiders programme.\n- Technical data: your device type, browser and the pages you visit, kept in the cookies and local storage listed below.',
  },
  {
    heading: 'Why we use it',
    body: '- To take, cook, deliver and refund your order, and to tell you how it is going.\n- To keep your account safe (one-time codes, blocking abuse and fake orders).\n- To run bookings, the waitlist and the Insiders rewards.\n- To answer your messages and complaints.\n- To keep our tax and accounting records, which Pakistani law requires us to keep.\n- To understand how the site is used and to make it faster and easier. Analytics are used only if you accept them.\n- To send you offers by WhatsApp or email only if you have agreed to receive them. You can say stop at any time.',
  },
  {
    heading: 'Cookies and similar storage',
    body: 'We use a small number of cookies and browser storage items:\n- sv_vid — a first-party cookie that gives your browser a random visitor id. It lets us show you the same version of a page when we test two designs, and count visits without knowing who you are. It holds no personal details.\n- _asid — a random session id kept in your browser storage for our own, first-party usage counts (pages seen, items added, orders placed).\n- sv_consent — remembers whether you accepted or declined analytics cookies.\n- Sign-in storage — keeps you signed in on your device.\n- Analytics cookies (Google Analytics 4: _ga and _ga_ followed by an id) — set only if you press Accept on the notice. They tell us which pages and dishes are popular. If you decline, Google Analytics is not loaded and sets nothing.\nOrdering works whether you accept or decline. You can also clear cookies and storage in your browser settings at any time.',
  },
  {
    heading: 'Who we share it with',
    body: 'We do not sell your personal information. We share it only with:\n- The kitchen and delivery team that prepares and brings your order (our own staff and riders, and a partner company if one of our companies shares its riders).\n- Service providers who help us run servd: hosting, WhatsApp delivery of codes and order updates, email, payment and card-machine providers, and Google Analytics if you accept analytics cookies. They may use your information only to do that job.\n- Tax and other authorities, where the law requires it.\nSome providers keep data on servers outside Pakistan.',
  },
  {
    heading: 'How long we keep it',
    body: 'We keep order and payment records for as long as tax and accounting rules require (usually six years). Account details are kept while your account is open. Contact messages are kept for as long as needed to answer you and for a reasonable time after. Analytics data is kept in aggregate form. When we no longer need personal information, we delete or anonymise it.',
  },
  {
    heading: 'Your choices',
    body: 'You can ask us to show you what we hold about you, correct it, or delete your account and the personal information we are not required to keep. You can withdraw marketing consent at any time. To do any of this, write to servd@gsfoods.pk from the email or tell us the phone number on your account so we can check it is you. We will answer within a reasonable time, normally within 30 days.',
  },
  {
    heading: 'Children',
    body: 'servd is for adults and for young people ordering with an adult. We do not knowingly collect information from children under 13. If you think a child has given us information, tell us and we will delete it.',
  },
  {
    heading: 'Security',
    body: 'We protect your information with access controls, encrypted connections and one-time codes for sign-in. No online service is perfectly secure, so please keep your phone and codes private. If we find a breach that puts your information at risk, we will tell the people affected and the authorities as the law requires.',
  },
  {
    heading: 'Changes to this page',
    body: 'We will update this page when we change what we do, and show the date it was last updated. Material changes will be noticed on servd.pk before they apply.',
  },
  {
    heading: 'Contact us about your data',
    body: 'GS Foods Pvt. Ltd., Karachi, Pakistan. Email servd@gsfoods.pk, or use the contact form at servd.pk/contact and choose the topic that fits. This page is governed by the laws of Pakistan.',
  },
]

export const TERMS_INTRO =
  'These terms apply when you order, book or use servd.pk and the kitchen sites run by GS Foods Pvt. Ltd. in Karachi, Pakistan. By placing an order or creating an account you agree to them. If you do not agree, please do not use the service.'

export const TERMS_SECTIONS: PolicySection[] = [
  {
    heading: 'Who you are dealing with',
    body: 'servd is an ordering service. The food is cooked and sold by the kitchen you order from, which is one of the brands of an operating company within GS Foods. Your receipt names the kitchen. We do not sell through third-party delivery marketplaces; delivery is by our own riders.',
  },
  {
    heading: 'Your account',
    body: 'You sign in with your phone number and a one-time code. You are responsible for what happens on your account, so keep your phone and codes private and tell us if you lose your phone. Give us true details; we may refuse or cancel an order if the details look false or the order looks like abuse.',
  },
  {
    heading: 'Menus, prices and availability',
    body: 'Prices are in Pakistani rupees (PKR) and show the price before the tax and fees added at checkout. Sales tax (GST) is added at the rate that applies to how you pay, and shown before you confirm. A delivery fee may apply and is shown before you confirm. Dishes can sell out and menus change; we may cancel or replace an item and will tell you. We do our best to keep photos, descriptions and allergen notes right, but if you have an allergy please tell us before you order and ask the kitchen to confirm.',
  },
  {
    heading: 'Placing and paying for an order',
    body: 'An order is accepted when the kitchen confirms it. You can pay by cash on the way it is offered, by card, or by Raast QR, depending on the kitchen and the order type. For Raast QR, an order is paid only when the money is confirmed on our side. We may ask for payment before preparing a large order.',
  },
  {
    heading: 'Delivery and pickup',
    body: 'Delivery times are estimates. Please give a correct address and a phone number we can reach. A rider will ask for a short code you are shown when handing over the order, so give it only to the rider with your order. If we cannot reach you or deliver after a reasonable try, we may cancel the order and, for a prepaid order, keep any cost we cannot recover for perishable food.',
  },
  {
    heading: 'Cancellations, problems and refunds',
    body: 'Tell us as soon as possible if something is wrong with your order — missing, wrong or not as it should be — through the contact page or the number on your receipt, and give your order reference. Where the fault is ours we will remake, replace or refund the affected items. Refunds go back the way you paid, or to your servd wallet if you choose. You may cancel before the kitchen starts preparing; after that we may not be able to. This section does not take away any right you have under consumer protection law in Pakistan.',
  },
  {
    heading: 'Table bookings and the waitlist',
    body: 'A booking is confirmed when you get a confirmation. Please tell us if you will be late or cannot come. A kitchen may ask for a deposit for larger tables; its conditions are shown when you book, and a deposit may be kept if you do not show up. Joining a waitlist is not a booking and does not hold a table.',
  },
  {
    heading: 'Insiders rewards, wallet, gift cards and promotions',
    body: 'Points, wallet balances, gift cards and promotion codes are for use at the company that issued them, have no cash value unless we say so, and cannot be sold or transferred. Promotions have their own conditions and dates, and may end at any time. We may cancel points or credit earned through abuse or a mistake.',
  },
  {
    heading: 'Using the site fairly',
    body: 'Do not use servd to place false orders, harass staff or riders, break or probe the site, scrape it at a scale that harms it, or do anything unlawful. We may suspend an account that does.',
  },
  {
    heading: 'Our content',
    body: 'The names, logos, photographs, menus and text on servd and the kitchen sites belong to GS Foods or are used with permission. You may share a page link or a dish photo for personal use; please do not copy the site or its images for commercial use without asking.',
  },
  {
    heading: 'Our responsibility',
    body: 'We take care to prepare food safely and to run the site reliably, but the site is provided as available and may be interrupted. To the extent the law allows, we are not liable for indirect or consequential loss, and our liability for any one order is limited to the price you paid for it. Nothing here limits liability that cannot be limited by law.',
  },
  {
    heading: 'Privacy',
    body: 'How we handle your personal information is explained in our Privacy page at servd.pk/privacy.',
  },
  {
    heading: 'Changes, law and contact',
    body: 'We may update these terms; the version on this page when you order applies to that order. These terms are governed by the laws of Pakistan and disputes are for the courts of Karachi, without taking away rights you have under consumer law. Questions: servd@gsfoods.pk or servd.pk/contact.',
  },
]
