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

  for (const customer of customers) {
    const alreadySent = await prisma.triggerLog.findFirst({
      where: { customerId: customer.id, triggerType: 'birthday', createdAt: { gte: new Date(today.getFullYear(), 0, 1) } },
    })
    if (alreadySent) continue

    const msg = `Happy birthday, ${customer.name ?? 'there'}! 🎂 Enjoy 25% off your next order — use code BDAY25 at servd.`
    if (customer.email) await sendEmail(customer.email, 'Happy Birthday from servd! 🎂', `<p>${msg}</p>`)
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
