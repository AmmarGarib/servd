import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendEmail, sendPhoneMessage } from '../lib/notify.js'
import { reachableCustomer, reachableAtCompany } from '../lib/marketingAudience.js'
import { calculatePointsValue } from '../lib/loyaltySettings.js'
import { creditPoints, creditPointsTx, bookEarn, loyaltyProgram } from '../modules/loyalty/service.js'
import { formatBrandName } from '../lib/brandName.js'
import { sandboxBlocks } from '../lib/sandbox.js'

// Automated customer messages and point bonuses.
//
//   - Audience: lib/marketingAudience.ts, always. Platform-level messages use
//     reachableCustomer; a company's own message (win-back) uses
//     reachableAtCompany. Filtering on marketingOptOutAt by hand here let
//     banned customers through and sent the milestone note to people who had
//     unsubscribed.
//   - Channel: email, else WhatsApp (owner decision 17 — no SMS).
//   - Points: every bonus goes through the loyalty service (creditPoints), so
//     the liability is booked and the value quoted is the company's (owner
//     decision 12: PKR 0.10 a point).
//   - Company: every bonus names the company GIVING it (LEDGER-R8 — loyalty
//     stays inside the company that issued it). Birthday: each company the
//     customer has points, orders or a preferred brand with. Milestone: spend
//     at ONE company's brands, credited by that company. Referral: the
//     company of the referee's first completed order. Never a guessed company
//     (latest order, oldest company) — no company, no bonus.

/** PKR text for what `points` are worth at `tenantId`. */
async function pointsWorth(points: number, tenantId: string): Promise<string> {
  const cents = await calculatePointsValue(points, tenantId)
  return `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
}

/** reachableAtCompany, cached per company for one run. */
function reachabilityCache() {
  const cache = new Map<string, Awaited<ReturnType<typeof reachableAtCompany>>>()
  return async (customerId: string, tenantId: string): Promise<boolean> => {
    if (!cache.has(tenantId)) cache.set(tenantId, await reachableAtCompany(tenantId))
    return (await prisma.customer.count({ where: { AND: [{ id: customerId }, cache.get(tenantId)!] } })) > 0
  }
}

/** Customers (of `ids`) who already hold an earn described `description` at `tenantId`. */
async function alreadyCredited(ids: string[], tenantId: string, description: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await prisma.loyaltyTransaction.findMany({
    where: { type: 'earn', description: { startsWith: description }, loyaltyAccount: { tenantId, customerId: { in: ids } } },
    select: { loyaltyAccount: { select: { customerId: true } } },
  })
  return new Set(rows.map((r) => r.loyaltyAccount.customerId))
}

/** Email when we have one, else WhatsApp. */
async function reach(c: { email: string | null; phone: string | null }, subject: string, html: string, text: string): Promise<void> {
  if (c.email) await sendEmail(c.email, subject, html)
  else if (c.phone) await sendPhoneMessage(c.phone, text)
}

export function startLoyaltyTriggerWorker() {
  if (sandboxBlocks('worker', { summary: 'loyaltyTriggers' })) return // practice copy: its job is messaging real customers
  try {
    const triggersQueue = new Queue('loyalty-triggers', {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 500 }, removeOnFail: { count: 200 } },
    })

    void triggersQueue.add('scan', {}, {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'loyalty-scan-recurring',
    }).catch((err: Error) => console.warn('[loyaltyTriggers] schedule failed:', err.message))

    const worker = new Worker(
      'loyalty-triggers',
      async () => {
        await runBirthdayTriggers()
        await runWinBackTriggers()
        await runActivateUsersTrigger()
        await runEncourageSecondOrderTrigger()
        await runAbandonedCartTrigger()
        await runFirstOrderWelcomeTrigger()
        await runComplaintFollowUpTrigger()
        await runSpendMilestoneTrigger()
        await runReferralRewardTrigger()
      },
      { connection: redis, concurrency: 1 },
    )

    worker.on('failed', (job, err) => {
      console.error(`[loyaltyTriggers] job ${job?.id} failed: ${err.message}`)
    })
    worker.on('error', (err) => {
      console.error('[loyaltyTriggers] worker error:', err.message)
    })

    return worker
  } catch (err) {
    console.warn('[loyaltyTriggers] worker disabled (Redis unavailable):', (err as Error).message)
    return null
  }
}

// Birthday — owner decision 12: the reward is the company's birthday bonus in
// points (loyalty.birthday_bonus_points, default 500), credited once a year BY
// EACH COMPANY the customer belongs to — one they hold points with, have
// ordered from, or signed up through (preferred brand) — at that company's
// own rate and on its books. A customer who belongs to no company gets none
// (it used to land at the oldest company on the system).
export async function runBirthdayTriggers(today = new Date()) {
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  const year = today.getFullYear()
  const yearStart = new Date(year, 0, 1)
  const reachable = reachabilityCache()

  const customers = await prisma.customer.findMany({
    where: { birthdayMmDd: `${mm}-${dd}`, deletedAt: null },
    select: {
      id: true, name: true, email: true, phone: true,
      preferredConcept: { select: { tenantId: true } },
      loyaltyAccounts: { select: { tenantId: true } },
    },
  })
  const tenantNames = new Map((await prisma.tenant.findMany({ select: { id: true, name: true } })).map((t) => [t.id, t.name]))

  for (const customer of customers) {
    const ordered = await prisma.order.findMany({
      where: { customerId: customer.id, deletedAt: null, concept: { tenantId: { not: null } } },
      select: { concept: { select: { tenantId: true } } },
      distinct: ['conceptId'],
    })
    const companies = [...new Set([
      ...customer.loyaltyAccounts.map((a) => a.tenantId),
      ...ordered.map((o) => o.concept.tenantId),
      customer.preferredConcept?.tenantId,
    ].filter((t): t is string => !!t))]

    for (const tenantId of companies) {
      const triggerType = `birthday.${tenantId}`
      const sent = await prisma.triggerLog.findFirst({ where: { customerId: customer.id, triggerType, createdAt: { gte: yearStart } } })
      if (sent) continue
      // A bonus this year already on this company's account (incl. one the
      // old company-less trigger credited here) counts as sent.
      const description = `Birthday bonus ${year}`
      if ((await alreadyCredited([customer.id], tenantId, description)).size > 0) continue
      if (!(await reachable(customer.id, tenantId))) continue

      const program = await loyaltyProgram(tenantId)
      const bonus = program.birthdayBonusPoints
      if (bonus <= 0) continue
      await creditPoints({ customerId: customer.id, tenantId, points: bonus, description })
      const company = tenantNames.get(tenantId) ?? 'servd'
      const worth = `PKR ${((bonus * program.pointValueCents) / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
      const msg = `Happy birthday, ${customer.name ?? 'there'}! ${company} has added ${bonus} loyalty points to your account — ${worth} off your next order with us.`
      await reach(customer, `Happy birthday from ${company}`, `<p>${msg}</p>`, msg).catch(() => {})
      await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType } })
    }
  }
}

// Win-back — owner decision 16: the message goes to each company's LAPSED
// segment (no order at its brands in 60 days, at least one before), computed
// nightly by modules/crm/segmentComputation.ts. Once per company per 30 days.
async function runWinBackTriggers() {
  const { segmentMemberIds } = await import('../modules/crm/segmentComputation.js')
  const companies = await prisma.tenant.findMany({ select: { id: true } })
  for (const { id: tenantId } of companies) {
    const lapsed = await segmentMemberIds('lapsed', [tenantId])
    if (lapsed.length === 0) continue
    const triggerType = `winback.${tenantId}`
    const customers = await prisma.customer.findMany({
      where: { AND: [{ id: { in: lapsed } }, await reachableAtCompany(tenantId)] },
      select: { id: true, name: true, email: true, phone: true },
      take: 100,
    })
    for (const customer of customers) {
      const alreadySent = await prisma.triggerLog.findFirst({
        where: { customerId: customer.id, triggerType, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      })
      if (alreadySent) continue

      const msg = `We miss you! It's been a while. Come back and get Rs. 200 off — use code COMEBACK at checkout.`
      await reach(customer, 'We miss you — come back to servd', `<p>Hi ${customer.name ?? 'there'},</p><p>${msg}</p>`, msg).catch(() => {})
      await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType } })
    }
  }
}

// Users who signed up but never placed an order (within 3 days of signup)
async function runActivateUsersTrigger() {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
  const oneDayAgo = new Date(Date.now() - 86_400_000)

  const customers = await prisma.customer.findMany({
    where: {
      ...reachableCustomer,
      createdAt: { gte: threeDaysAgo, lte: oneDayAgo },
      firstOrderAt: null,
    },
    select: { id: true, name: true, email: true, phone: true },
    take: 200,
  })

  for (const customer of customers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: customer.id, triggerType: 'activate' },
    })
    if (alreadySent) continue

    const msg = `Hey ${customer.name ?? 'there'}! You signed up at servd but haven't ordered yet. Get your first order delivered — use WELCOME15 for 15% off!`
    await reach(customer, 'Your first servd order is waiting! 🍽', `<p>${msg}</p>`, msg).catch(() => {})

    await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType: 'activate' } })
  }
}

// Users who placed exactly 1 order and haven't placed a second in 15 days
async function runEncourageSecondOrderTrigger() {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000)

  const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM customers c
    WHERE c."firstOrderAt" < ${fifteenDaysAgo}
      AND (SELECT COUNT(*) FROM orders o WHERE o."customerId" = c.id AND o."deletedAt" IS NULL) = 1
    LIMIT 500
  `
  const singleOrderCustomers = await prisma.customer.findMany({
    where: { id: { in: candidates.map((c) => c.id) }, ...reachableCustomer },
    select: { id: true, name: true, email: true, phone: true },
    take: 100,
  })

  for (const customer of singleOrderCustomers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: customer.id, triggerType: 'second_order', createdAt: { gte: new Date(Date.now() - 15 * 86_400_000) } },
    })
    if (alreadySent) continue

    const msg = `${customer.name ?? 'Hey'}! You loved your first order — ready for your second? Order again and get Rs. 100 off with code SECOND100.`
    await reach(customer, 'Ready for round 2? 🍔', `<p>${msg}</p>`, msg).catch(() => {})

    await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType: 'second_order' } })
  }
}

// First-order welcome — fires within ~1h of a customer's first completed
// order. Brief warm note ("thanks for trying us"), no discount stuffed in
// because it's not a winback hook — it's just being human.
async function runFirstOrderWelcomeTrigger() {
  const oneHourAgo  = new Date(Date.now() - 1 * 3_600_000)
  const sixHoursAgo = new Date(Date.now() - 6 * 3_600_000)

  const customers = await prisma.customer.findMany({
    where: {
      ...reachableCustomer,
      firstOrderAt: { gte: sixHoursAgo, lte: oneHourAgo },
    },
    select: { id: true, name: true, email: true, phone: true },
    take: 100,
  })

  for (const c of customers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: c.id, triggerType: 'welcome' },
    })
    if (alreadySent) continue

    const name = c.name ?? 'there'
    const sms  = `Welcome to servd, ${name}! 🍽 Thanks for your first order — we'll keep cooking better just because you said yes.`
    const html = `<p>Hi ${name},</p>
      <p>Thanks for your first order at servd. We hope it landed.</p>
      <p>If anything was off — and even if it wasn't — we'd love to hear from you. Reply to this email any time.</p>
      <p>Cooking with care,<br/>The servd team</p>`

    await reach(c, 'Thanks for your first order 🍽', html, sms).catch(() => {})

    await prisma.triggerLog.create({ data: { customerId: c.id, triggerType: 'welcome' } })
  }
}

// Post-complaint follow-up — fires 24h after a complaint is marked resolved.
// "Did we make it right?" — gives the customer a chance to feel heard, gives
// the manager a chance to catch a botched recovery before it becomes a bad
// review. Idempotent via OrderComplaint.followUpSentAt.
async function runComplaintFollowUpTrigger() {
  const oneDayAgo  = new Date(Date.now() - 24 * 3_600_000)
  const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000)

  const complaints = await prisma.orderComplaint.findMany({
    where: {
      status: 'resolved',
      resolvedAt: { gte: fourDaysAgo, lte: oneDayAgo },
      followUpSentAt: null,
    },
    select: {
      id: true, customerId: true,
      concept: { select: { name: true } },
      order:   { select: { customer: { select: { name: true, email: true, phone: true } } } },
    },
    take: 100,
  })

  for (const c of complaints) {
    // Resolve customer contact — either via order.customer or via
    // customerId (rare; complaints can be filed without a customer record).
    let contact: { name: string | null; email: string | null; phone: string | null } | null = null
    if (c.order?.customer) {
      contact = c.order.customer
    } else if (c.customerId) {
      contact = await prisma.customer.findUnique({
        where: { id: c.customerId },
        select: { name: true, email: true, phone: true },
      })
    }

    if (contact && (contact.email || contact.phone)) {
      const name = contact.name ?? 'there'
      const sms = `Hi ${name}, this is ${formatBrandName(c.concept.name)}. We resolved your earlier issue — did we make it right? Reply with your honest take, we read every word.`
      const html = `<p>Hi ${name},</p>
        <p>It's the team at <strong>${formatBrandName(c.concept.name)}</strong>. A few days ago you raised something with us, and we tried to put it right.</p>
        <p>Did we?</p>
        <p>If yes, we'd love to hear it. If not — we want to know more than anything. Reply to this email and the manager will personally read it.</p>
        <p>— ${formatBrandName(c.concept.name)}</p>`

      // A service follow-up on the customer's own complaint, not marketing.
      await reach(contact, `${formatBrandName(c.concept.name)}: did we make it right?`, html, sms).catch(() => {})
    }

    await prisma.orderComplaint.update({
      where: { id: c.id },
      data: { followUpSentAt: new Date() },
    })
  }
}

// Spend milestone — celebrate when a customer crosses a lifetime threshold
// (PKR 25k / 50k / 100k / 250k) AT ONE COMPANY's brands: bonus loyalty points
// from that company, credited through the loyalty service (liability booked
// in its books), plus a thank-you note when that company may reach them. Once
// per threshold per customer per company (TriggerLog
// `milestone_<amount>.<tenantId>`, and the earn itself). It used to read
// Customer.totalSpentCents — spend at EVERY company — and credit whichever
// company the customer last ordered from.
export async function runSpendMilestoneTrigger() {
  const MILESTONES_CENTS = [
    { threshold: 2_500_000,  label: 'PKR 25,000',  bonus: 100 },
    { threshold: 5_000_000,  label: 'PKR 50,000',  bonus: 200 },
    { threshold: 10_000_000, label: 'PKR 100,000', bonus: 500 },
    { threshold: 25_000_000, label: 'PKR 250,000', bonus: 1500 },
  ] as const
  const reachable = reachabilityCache()
  const companies = await prisma.tenant.findMany({ select: { id: true, name: true } })

  for (const { id: tenantId, name: company } of companies) {
    for (const m of MILESTONES_CENTS) {
      const triggerKey = `milestone_${m.threshold}.${tenantId}`
      // Lifetime spend at this company's brands: what its completed orders charged.
      const spenders = await prisma.order.groupBy({
        by: ['customerId'],
        where: { status: 'completed', deletedAt: null, customerId: { not: null }, concept: { tenantId } },
        _sum: { totalCents: true },
        having: { totalCents: { _sum: { gte: m.threshold } } },
      })
      const ids = spenders.map((r) => r.customerId).filter((x): x is string => !!x)
      if (ids.length === 0) continue
      const description = `Milestone: ${m.label} lifetime spend`
      const [logged, credited, live] = await Promise.all([
        prisma.triggerLog.findMany({ where: { customerId: { in: ids }, triggerType: triggerKey }, select: { customerId: true } }),
        alreadyCredited(ids, tenantId, description),
        prisma.customer.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, email: true, phone: true } }),
      ])
      const done = new Set([...logged.map((l) => l.customerId), ...credited])
      const due = live.filter((c) => !done.has(c.id)).slice(0, 100)

      for (const c of due) {
        await creditPoints({ customerId: c.id, tenantId, points: m.bonus, description })

        if (await reachable(c.id, tenantId)) {
          const name = c.name ?? 'there'
          const worth = await pointsWorth(m.bonus, tenantId)
          const msg = `${name} — you've spent ${m.label} with ${company}. That's not nothing. Here's ${m.bonus} bonus loyalty points (${worth} off) and a thank-you that means it.`
          const html = `<p>Hi ${name},</p>
            <p>Quietly, we noticed: you've spent <strong>${m.label}</strong> with ${company}.</p>
            <p>That's the kind of loyalty restaurants don't earn lightly. Thank you.</p>
            <p>We've credited <strong>${m.bonus} loyalty points</strong> to your account — that's ${worth} off whenever you next order with us.</p>
            <p>Genuinely,<br/>${company}</p>`
          await reach(c, `Thanks for ${m.label}`, html, msg).catch(() => {})
        }

        await prisma.triggerLog.create({ data: { customerId: c.id, triggerType: triggerKey } })
      }
    }
  }
}

// Referral reward — when a referred customer's first order completes, BOTH
// parties get a bonus. Idempotent via referralRewardCreditedAt stamp.
// Exported so the guards below can be exercised directly in a test rather
// than by waiting out the worker's schedule.
export async function runReferralRewardTrigger() {
  const REFERRER_BONUS = 200
  const REFEREE_BONUS  = 200

  // ─── Anti-farming guards ───────────────────────────────────────────────────
  //
  // 200 + 200 points is PKR 400 of real value per referral, and signing up
  // costs an email address. Without these, a script with disposable addresses
  // mints PKR 400 a head, and the only thing standing in the way is the price
  // of one order.
  //
  //   MIN_FIRST_ORDER_CENTS  The referral must not pay out more than the order
  //                          that triggered it was worth. Below this the whole
  //                          exercise is the operator paying someone to take
  //                          money off them.
  //   MAX_PER_REFERRER_30D   A real customer refers friends and family. Someone
  //                          past this in a month is running a farm, and the
  //                          cap turns an unbounded loss into a bounded one.
  //                          Referrals beyond it still register — they just
  //                          don't pay, and they wait rather than being voided,
  //                          so a genuinely popular referrer collects next
  //                          month instead of losing them.
  //
  // The referee's phone must also be verified. An email address is free and
  // infinite; a phone number that receives a WhatsApp OTP is neither, and it is
  // the cheapest thing standing between a marketing budget and a script.
  const MIN_FIRST_ORDER_CENTS = 50_000   // PKR 500
  const MAX_PER_REFERRER_30D  = 10
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)

  // Pull referred customers who placed their first order recently AND whose
  // referral reward hasn't been credited yet. The loyalty service opens an
  // account for either side that has none.
  const referees = await prisma.customer.findMany({
    where: {
      referredById:             { not: null },
      firstOrderAt:             { not: null },
      referralRewardCreditedAt: null,
    },
    select: {
      id: true, name: true, phoneVerifiedAt: true,
      referredBy: { select: { id: true, name: true, email: true, phone: true, marketingOptOutAt: true, bannedAt: true } },
    },
    take: 100,
  })

  for (const referee of referees) {
    const referrer = referee.referredBy
    if (!referrer) {
      // The referrer is gone — stamp so we don't keep trying.
      await prisma.customer.update({
        where: { id: referee.id },
        data: { referralRewardCreditedAt: new Date() },
      })
      continue
    }

    // Unverified phone: no payout, and no stamp either. If they verify later,
    // this referral is picked up on a subsequent run.
    if (!referee.phoneVerifiedAt) continue

    // The order that triggered this has to be worth more than the reward.
    // Its company gives both bonuses (F1 / LEDGER-R8): the referral paid off
    // for that company, whose books carry the liability.
    const firstOrder = await prisma.order.findFirst({
      where: { customerId: referee.id, status: 'completed', deletedAt: null },
      select: { totalCents: true, concept: { select: { tenantId: true } } },
      orderBy: { completedAt: 'asc' },
    })
    const tenantId = firstOrder?.concept.tenantId ?? null
    if (!firstOrder || !tenantId || firstOrder.totalCents < MIN_FIRST_ORDER_CENTS) {
      // Not a fraud signal on its own — someone may just have bought a drink.
      // Leave it unstamped so a later, larger first order isn't needed; the
      // referral simply doesn't pay on this one.
      continue
    }

    // Monthly cap per referrer.
    const rewardedRecently = await prisma.customer.count({
      where: {
        referredById: referrer.id,
        referralRewardCreditedAt: { gte: thirtyDaysAgo },
      },
    })
    if (rewardedRecently >= MAX_PER_REFERRER_30D) {
      console.warn(
        `[referral] ${referrer.id} has hit the ${MAX_PER_REFERRER_30D}/30d payout cap — ` +
        `holding the reward for referee ${referee.id}. Worth a look if this keeps happening.`,
      )
      continue
    }

    // Both bonuses through the loyalty service, in one transaction with the
    // stamp; the liability for each is booked once it commits.
    const [refereeTx, referrerTx] = await prisma.$transaction(async (tx) => {
      const a = await creditPointsTx(tx, {
        customerId: referee.id,
        tenantId,
        points: REFEREE_BONUS,
        description: `Welcome bonus: signed up via ${referrer.name}'s referral`,
      })
      const b = await creditPointsTx(tx, {
        customerId: referrer.id,
        tenantId,
        points: REFERRER_BONUS,
        description: `Referral bonus: ${referee.name} completed their first order`,
      })
      await tx.customer.update({
        where: { id: referee.id },
        data: { referralRewardCreditedAt: new Date() },
      })
      return [a.txId, b.txId] as const
    })
    await bookEarn(refereeTx)
    await bookEarn(referrerTx)

    // Notify the referrer, when marketing may reach them.
    if (referrer.bannedAt || referrer.marketingOptOutAt) continue
    const msg = `${referee.name ?? 'Your friend'} just placed their first order using your code — you've got ${REFERRER_BONUS} loyalty points (${await pointsWorth(REFERRER_BONUS, tenantId)} off your next order). Thanks for the love.`
    await reach(referrer, `Your friend ordered — points credited`, `<p>${msg}</p>`, msg).catch(() => {})
  }
}

// Abandoned cart reminders — carts not converted in last 2 hours
async function runAbandonedCartTrigger() {
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000)
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 3_600_000)

  const carts = await prisma.abandonedCart.findMany({
    where: {
      abandonedAt: { gte: twentyFourHoursAgo, lte: twoHoursAgo },
      recoveredAt: null,
      reminderSentAt: null,
    },
    include: { concept: { select: { tenantId: true } } },
    take: 200,
  })

  for (const cart of carts) {
    // A known customer must still be reachable by the cart's company.
    if (cart.customerId && cart.concept.tenantId) {
      const ok = await prisma.customer.count({ where: { AND: [{ id: cart.customerId }, await reachableAtCompany(cart.concept.tenantId)] } })
      if (ok === 0) {
        await prisma.abandonedCart.update({ where: { id: cart.id }, data: { reminderSentAt: new Date() } })
        continue
      }
    }
    const msg = `You left something in your cart! Complete your order and enjoy your meal. It's waiting for you.`

    let sent = false
    if (cart.customerEmail) {
      await sendEmail(cart.customerEmail, 'You forgot something! 🛒', `<p>${msg}</p>`).catch(() => {})
      sent = true
    } else if (cart.customerPhone) {
      await sendPhoneMessage(cart.customerPhone, msg).catch(() => {})
      sent = true
    }

    if (sent) {
      await prisma.abandonedCart.update({ where: { id: cart.id }, data: { reminderSentAt: new Date() } })
    }
  }
}
