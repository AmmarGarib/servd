import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { sendEmail, sendSms } from '../lib/notify.js'

export function startLoyaltyTriggerWorker() {
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

async function runBirthdayTriggers() {
  const today = new Date()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')

  const customers = await prisma.customer.findMany({
    where: { birthdayMmDd: `${mm}-${dd}`, marketingOptIn: true, deletedAt: null },
    select: { id: true, name: true, email: true, phone: true },
  })

  const { getCustomerPerks } = await import('../lib/tierPerks.js')

  for (const customer of customers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: customer.id, triggerType: 'birthday', createdAt: { gte: new Date(today.getFullYear(), 0, 1) } },
    })
    if (alreadySent) continue

    // Tier-based birthday perk:
    //   gold + freeBirthdayItem → "free meal up to PKR X"
    //   silver/gold w/ birthdayDiscountPct override → custom %
    //   bronze (or no override) → 25% via BDAY25
    const perks = await getCustomerPerks(customer.id)
    let msg: string
    let subject = 'Happy Birthday from servd! 🎂'
    if (perks.freeBirthdayItem) {
      msg = `Happy birthday, ${customer.name ?? 'there'}! 🎂 As a gold member, your meal is on us today — up to PKR 2,000. Use code BDAYGOLD at checkout.`
      subject = `Your birthday meal is on us 🎂`
    } else if (perks.birthdayDiscountPct && perks.birthdayDiscountPct > 25) {
      msg = `Happy birthday, ${customer.name ?? 'there'}! 🎂 As a ${perks.tier} member, enjoy ${perks.birthdayDiscountPct}% off your next order — use code BDAY${perks.birthdayDiscountPct} at servd.`
    } else {
      msg = `Happy birthday, ${customer.name ?? 'there'}! 🎂 Enjoy 25% off your next order — use code BDAY25 at servd.`
    }
    if (customer.email) await sendEmail(customer.email, subject, `<p>${msg}</p>`)
    else if (customer.phone) await sendSms(customer.phone, msg)

    await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType: 'birthday' } })
  }
}

async function runWinBackTriggers() {
  const cutoff = new Date(Date.now() - 30 * 86_400_000)

  const customers = await prisma.customer.findMany({
    where: { marketingOptIn: true, deletedAt: null, lastOrderAt: { lt: cutoff }, orders: { some: {} } },
    select: { id: true, name: true, email: true, phone: true },
    take: 100,
  })

  for (const customer of customers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: customer.id, triggerType: 'winback', createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    })
    if (alreadySent) continue

    const msg = `We miss you! It's been a while. Come back and get Rs. 200 off — use code COMEBACK at checkout.`
    if (customer.email) await sendEmail(customer.email, 'We miss you — come back to servd', `<p>Hi ${customer.name ?? 'there'},</p><p>${msg}</p>`)
    else if (customer.phone) await sendSms(customer.phone, msg)

    await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType: 'winback' } })
  }
}

// Users who signed up but never placed an order (within 3 days of signup)
async function runActivateUsersTrigger() {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
  const oneDayAgo = new Date(Date.now() - 86_400_000)

  const customers = await prisma.customer.findMany({
    where: {
      marketingOptIn: true,
      deletedAt: null,
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
    if (customer.email) await sendEmail(customer.email, 'Your first servd order is waiting! 🍽', `<p>${msg}</p>`)
    else if (customer.phone) await sendSms(customer.phone, msg)

    await prisma.triggerLog.create({ data: { customerId: customer.id, triggerType: 'activate' } })
  }
}

// Users who placed exactly 1 order and haven't placed a second in 15 days
async function runEncourageSecondOrderTrigger() {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000)

  const singleOrderCustomers = await prisma.$queryRaw<Array<{ id: string; name: string; email: string | null; phone: string | null }>>`
    SELECT c.id, c.name, c.email, c.phone
    FROM customers c
    WHERE c."marketingOptIn" = true
      AND c."deletedAt" IS NULL
      AND c."firstOrderAt" < ${fifteenDaysAgo}
      AND (SELECT COUNT(*) FROM orders o WHERE o."customerId" = c.id AND o."deletedAt" IS NULL) = 1
    LIMIT 100
  `

  for (const customer of singleOrderCustomers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: customer.id, triggerType: 'second_order', createdAt: { gte: new Date(Date.now() - 15 * 86_400_000) } },
    })
    if (alreadySent) continue

    const msg = `${customer.name ?? 'Hey'}! You loved your first order — ready for your second? Order again and get Rs. 100 off with code SECOND100.`
    if (customer.email) await sendEmail(customer.email, 'Ready for round 2? 🍔', `<p>${msg}</p>`)
    else if (customer.phone) await sendSms(customer.phone, msg)

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
      deletedAt: null,
      firstOrderAt: { gte: sixHoursAgo, lte: oneHourAgo },
    },
    select: { id: true, name: true, email: true, phone: true, marketingOptIn: true },
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

    if (c.email) await sendEmail(c.email, 'Thanks for your first order 🍽', html).catch(() => {})
    else if (c.phone && c.marketingOptIn) await sendSms(c.phone, sms).catch(() => {})

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
      const sms = `Hi ${name}, this is ${c.concept.name}. We resolved your earlier issue — did we make it right? Reply with your honest take, we read every word.`
      const html = `<p>Hi ${name},</p>
        <p>It's the team at <strong>${c.concept.name}</strong>. A few days ago you raised something with us, and we tried to put it right.</p>
        <p>Did we?</p>
        <p>If yes, we'd love to hear it. If not — we want to know more than anything. Reply to this email and the manager will personally read it.</p>
        <p>— ${c.concept.name}</p>`

      if (contact.email) await sendEmail(contact.email, `${c.concept.name}: did we make it right?`, html).catch(() => {})
      else if (contact.phone) await sendSms(contact.phone, sms).catch(() => {})
    }

    await prisma.orderComplaint.update({
      where: { id: c.id },
      data: { followUpSentAt: new Date() },
    })
  }
}

// Spend milestone — celebrate when a customer crosses a meaningful lifetime
// threshold (PKR 25k / 50k / 100k / 250k). Sends a personal "thank you for
// being a regular" note plus 200 bonus loyalty points. Once per threshold
// per customer (TriggerLog with `milestone_<amount>` type).
async function runSpendMilestoneTrigger() {
  const MILESTONES_CENTS = [
    { threshold: 2_500_000,  label: 'PKR 25,000',  bonus: 100 },
    { threshold: 5_000_000,  label: 'PKR 50,000',  bonus: 200 },
    { threshold: 10_000_000, label: 'PKR 100,000', bonus: 500 },
    { threshold: 25_000_000, label: 'PKR 250,000', bonus: 1500 },
  ] as const

  for (const m of MILESTONES_CENTS) {
    const customers = await prisma.customer.findMany({
      where: {
        deletedAt: null,
        totalSpentCents: { gte: m.threshold },
      },
      select: {
        id: true, name: true, email: true, phone: true, marketingOptIn: true,
        loyaltyAccount: { select: { id: true } },
      },
      take: 100,
    })

    const triggerKey = `milestone_${m.threshold}`
    for (const c of customers) {
      const alreadySent = await prisma.triggerLog.findFirst({
        where: { customerId: c.id, triggerType: triggerKey },
      })
      if (alreadySent) continue

      const name = c.name ?? 'there'
      const msg = `${name} — you've spent ${m.label} with us. That's not nothing. Here's ${m.bonus} bonus loyalty points and a thank-you that means it.`
      const html = `<p>Hi ${name},</p>
        <p>Quietly, we noticed: you've spent <strong>${m.label}</strong> with us.</p>
        <p>That's the kind of loyalty restaurants don't earn lightly. Thank you.</p>
        <p>We've credited <strong>${m.bonus} loyalty points</strong> to your account — that's PKR ${m.bonus} off whenever you next order.</p>
        <p>Genuinely,<br/>The servd team</p>`

      if (c.email) await sendEmail(c.email, `Thanks for ${m.label}`, html).catch(() => {})
      else if (c.phone && c.marketingOptIn) await sendSms(c.phone, msg).catch(() => {})

      // Credit the bonus, if they have an account.
      if (c.loyaltyAccount) {
        await prisma.$transaction([
          prisma.loyaltyAccount.update({
            where: { id: c.loyaltyAccount.id },
            data: { pointsBalance: { increment: m.bonus }, lifetimePoints: { increment: m.bonus } },
          }),
          prisma.loyaltyTransaction.create({
            data: {
              loyaltyAccountId: c.loyaltyAccount.id,
              type: 'earn',
              pointsDelta: m.bonus,
              description: `Milestone: ${m.label} lifetime spend`,
            },
          }),
        ])
      }

      await prisma.triggerLog.create({ data: { customerId: c.id, triggerType: triggerKey } })
    }
  }
}

// Referral reward — when a referred customer's first order completes, BOTH
// parties get a bonus. Idempotent via referralRewardCreditedAt stamp.
async function runReferralRewardTrigger() {
  const REFERRER_BONUS = 200
  const REFEREE_BONUS  = 200

  // Pull referred customers who placed their first order recently AND whose
  // referral reward hasn't been credited yet. We require BOTH parties to
  // have a loyalty account — if not, we still mark the row credited so we
  // don't loop forever (genuine edge case).
  const referees = await prisma.customer.findMany({
    where: {
      referredById:             { not: null },
      firstOrderAt:             { not: null },
      referralRewardCreditedAt: null,
    },
    select: {
      id: true, name: true,
      loyaltyAccount: { select: { id: true } },
      referredBy: { select: { id: true, name: true, email: true, phone: true, marketingOptIn: true, loyaltyAccount: { select: { id: true } } } },
    },
    take: 100,
  })

  for (const referee of referees) {
    const refereeAccount  = referee.loyaltyAccount
    const referrer        = referee.referredBy
    const referrerAccount = referrer?.loyaltyAccount

    if (!refereeAccount || !referrer || !referrerAccount) {
      // Stamp anyway so we don't keep trying to credit accounts that don't exist.
      await prisma.customer.update({
        where: { id: referee.id },
        data: { referralRewardCreditedAt: new Date() },
      })
      continue
    }

    await prisma.$transaction([
      prisma.loyaltyAccount.update({
        where: { id: refereeAccount.id },
        data: {
          pointsBalance:  { increment: REFEREE_BONUS },
          lifetimePoints: { increment: REFEREE_BONUS },
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: refereeAccount.id,
          type: 'earn',
          pointsDelta: REFEREE_BONUS,
          description: `Welcome bonus: signed up via ${referrer.name}'s referral`,
        },
      }),
      prisma.loyaltyAccount.update({
        where: { id: referrerAccount.id },
        data: {
          pointsBalance:  { increment: REFERRER_BONUS },
          lifetimePoints: { increment: REFERRER_BONUS },
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: referrerAccount.id,
          type: 'earn',
          pointsDelta: REFERRER_BONUS,
          description: `Referral bonus: ${referee.name} completed their first order`,
        },
      }),
      prisma.customer.update({
        where: { id: referee.id },
        data: { referralRewardCreditedAt: new Date() },
      }),
    ])

    // Notify the referrer.
    const msg = `🎉 ${referee.name ?? 'Your friend'} just placed their first order using your code — you've got ${REFERRER_BONUS} loyalty points (PKR ${REFERRER_BONUS} off your next order). Thanks for the love.`
    if (referrer.email) await sendEmail(referrer.email, `Your friend ordered — points credited`, `<p>${msg}</p>`).catch(() => {})
    else if (referrer.phone && referrer.marketingOptIn) await sendSms(referrer.phone, msg).catch(() => {})
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
    take: 200,
  })

  for (const cart of carts) {
    const msg = `You left something in your cart! Complete your order and enjoy your meal. It's waiting for you.`

    let sent = false
    if (cart.customerEmail) {
      await sendEmail(cart.customerEmail, 'You forgot something! 🛒', `<p>${msg}</p>`).catch(() => {})
      sent = true
    } else if (cart.customerPhone) {
      await sendSms(cart.customerPhone, msg).catch(() => {})
      sent = true
    }

    if (sent) {
      await prisma.abandonedCart.update({ where: { id: cart.id }, data: { reminderSentAt: new Date() } })
    }
  }
}
