// Full live-state seed for GS Foods / GS x Viva ecosystem.
// As CEO, this populates the entire system as it would look mid-service
// on a busy Monday evening in Karachi.
//
// Run: npx tsx scripts/seed-live-state.ts

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient({ log: ['warn', 'error'] })

const TENANT_ID = 'cmor0px030000i74hhccygzet'
const now       = new Date()
const PKT_OFFSET = 5 * 60 * 60 * 1000  // UTC+5

// ── Helpers ───────────────────────────────────────────────────────────────────

function pkt(h: number, m = 0): Date {
  const d = new Date()
  d.setUTCHours(h - 5, m, 0, 0)
  return d
}
function daysAgo(n: number, h = 12, m = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(h, m, 0, 0)
  return d
}
function today(h = 12, m = 0): Date {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}
function tomorrow(h = 20, m = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(h, m, 0, 0)
  return d
}
function dateOnly(offsetDays = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(0, 0, 0, 0)
  return d
}

async function main() {
  // Dev fixture only. Refuse production, and refuse to bake in a known
  // password — every seeded staff login uses SEED_STAFF_PASSWORD.
  if (process.env['NODE_ENV'] === 'production') {
    console.error('seed-live-state is a dev fixture — refusing to run with NODE_ENV=production')
    process.exit(1)
  }
  const seedPassword = process.env['SEED_STAFF_PASSWORD']
  if (!seedPassword || seedPassword.length < 8) {
    console.error('Set SEED_STAFF_PASSWORD (min 8 chars):  SEED_STAFF_PASSWORD=... npx tsx scripts/seed-live-state.ts')
    process.exit(1)
  }

  console.log('\n━━━ GS Foods Live-State Seed ━━━\n')

  // ── 1. Concepts ───────────────────────────────────────────────────────────

  console.log('1/14  Concepts...')

  const stax = await prisma.concept.upsert({
    where: { slug: 'stax' },
    update: { name: 'Stax', primaryColor: '#D4581A', phone: '+92 21 3456 7890', address: 'DHA Phase 6, Bukhari Commercial, Karachi' },
    create: {
      slug: 'stax', name: 'Stax', type: 'digital',
      description: 'Smash burgers, loaded fries, house-made sauces. Double-smash technique.',
      primaryColor: '#D4581A', taxRate: 17, isActive: true,
      phone: '+92 21 3456 7890', address: 'DHA Phase 6, Bukhari Commercial, Karachi',
      tenantId: TENANT_ID,
    },
  })

  const simmer = await prisma.concept.upsert({
    where: { slug: 'simmer' },
    update: { name: 'Simmer', primaryColor: '#2D4A3E', phone: '+92 21 3456 7891', address: 'DHA Phase 6, Bukhari Commercial, Karachi' },
    create: {
      slug: 'simmer', name: 'Simmer', type: 'restaurant',
      description: 'Fine-casual mocktails + small plates. Plated service, seasonal menu.',
      primaryColor: '#2D4A3E', taxRate: 17, isActive: true,
      phone: '+92 21 3456 7891', address: 'DHA Phase 6, Bukhari Commercial, Karachi',
      tenantId: TENANT_ID,
    },
  })

  const flipd = await prisma.concept.upsert({
    where: { slug: 'flipd' },
    update: { name: 'Flipd', primaryColor: '#E5A100' },
    create: {
      slug: 'flipd', name: 'Flipd', type: 'digital',
      description: 'Buttermilk-brined, hand-breaded crispy chicken. Never reheated.',
      primaryColor: '#E5A100', taxRate: 17, isActive: true, tenantId: TENANT_ID,
    },
  })

  const strata = await prisma.concept.upsert({
    where: { slug: 'strata' },
    update: { name: 'Strata', primaryColor: '#2D6A4F' },
    create: {
      slug: 'strata', name: 'Strata', type: 'digital',
      description: 'High-protein bowls + wraps. Clean labels, macros on every lid.',
      primaryColor: '#2D6A4F', taxRate: 17, isActive: true, tenantId: TENANT_ID,
    },
  })

  const viva = await prisma.concept.upsert({
    where: { slug: 'gs-x-viva' },
    update: { name: 'GS x Viva', primaryColor: '#6C3EE8', phone: '+92 21 3587 2000', address: 'Viva Padel Club, DHA Phase 6, Karachi' },
    create: {
      slug: 'gs-x-viva', name: 'GS x Viva', type: 'restaurant',
      description: 'Exclusive club dining at Viva Padel. Elevated bites, fresh juices, post-match dining.',
      primaryColor: '#6C3EE8', taxRate: 17, isActive: true,
      phone: '+92 21 3587 2000', address: 'Viva Padel Club, DHA Phase 6, Karachi',
      tenantId: TENANT_ID,
    },
  })

  console.log('   ✓ Stax, Simmer, Flipd, Strata, GS x Viva')

  // ── 2. Staff Users ────────────────────────────────────────────────────────

  console.log('2/14  Staff users...')

  const pwHash = await bcrypt.hash(seedPassword, 10)

  const manager = await prisma.user.upsert({
    where: { email: 'aamir.khan@servd.pk' },
    update: {},
    create: {
      email: 'aamir.khan@servd.pk', name: 'Aamir Khan', password: pwHash,
      role: 'manager', tenantId: TENANT_ID, isActive: true,
      hourlyRateCents: 20000, wageAccountCode: '6032',
      conceptIds: [stax.id, simmer.id, flipd.id, strata.id, viva.id],
    },
  })

  const cashier1 = await prisma.user.upsert({
    where: { email: 'saad.mirza@servd.pk' },
    update: {},
    create: {
      email: 'saad.mirza@servd.pk', name: 'Saad Mirza', password: pwHash,
      role: 'cashier', tenantId: TENANT_ID, isActive: true,
      hourlyRateCents: 12000, wageAccountCode: '6031',
      conceptIds: [stax.id, simmer.id, flipd.id],
    },
  })

  const cashier2 = await prisma.user.upsert({
    where: { email: 'hira.baig@servd.pk' },
    update: {},
    create: {
      email: 'hira.baig@servd.pk', name: 'Hira Baig', password: pwHash,
      role: 'cashier', tenantId: TENANT_ID, isActive: true,
      hourlyRateCents: 12000, wageAccountCode: '6031',
      conceptIds: [viva.id, strata.id],
    },
  })

  const kitchen1 = await prisma.user.upsert({
    where: { email: 'farhan.shah@servd.pk' },
    update: {},
    create: {
      email: 'farhan.shah@servd.pk', name: 'Farhan Shah', password: pwHash, pin: pwHash,
      role: 'kitchen', tenantId: TENANT_ID, isActive: true,
      hourlyRateCents: 10000, wageAccountCode: '6030',
      conceptIds: [stax.id, flipd.id, strata.id],
    },
  })

  const kitchen2 = await prisma.user.upsert({
    where: { email: 'ayesha.noor@servd.pk' },
    update: {},
    create: {
      email: 'ayesha.noor@servd.pk', name: 'Ayesha Noor', password: pwHash, pin: pwHash,
      role: 'kitchen', tenantId: TENANT_ID, isActive: true,
      hourlyRateCents: 10000, wageAccountCode: '6030',
      conceptIds: [simmer.id, viva.id],
    },
  })

  console.log(`   ✓ 5 staff (Aamir Manager, Saad/Hira Cashier, Farhan/Ayesha Kitchen)`)

  // ── 3. Stations ──────────────────────────────────────────────────────────

  console.log('3/14  Stations...')

  async function upsertStation(name: string, conceptId: string, _color = '#6366f1') {
    const ex = await prisma.station.findFirst({ where: { name, conceptId } })
    if (ex) return ex
    return prisma.station.create({ data: { name, conceptId, isActive: true } })
  }

  const [stGrill, stFry, stExpo, stPrep] = await Promise.all([
    upsertStation('Grill',   stax.id, '#D4581A'),
    upsertStation('Fryer',   stax.id, '#E5A100'),
    upsertStation('Expo',    stax.id, '#6366f1'),
    upsertStation('Prep',    stax.id, '#22c55e'),
  ])
  const [sGrill, sPrep, sPlating] = await Promise.all([
    upsertStation('Grill',    simmer.id, '#2D4A3E'),
    upsertStation('Prep',     simmer.id, '#22c55e'),
    upsertStation('Plating',  simmer.id, '#a855f7'),
  ])
  const [fFry, fPrep] = await Promise.all([
    upsertStation('Fryer',  flipd.id, '#E5A100'),
    upsertStation('Prep',   flipd.id, '#22c55e'),
  ])
  const [trGrill, trPrep] = await Promise.all([
    upsertStation('Grill',  strata.id, '#2D6A4F'),
    upsertStation('Prep',   strata.id, '#22c55e'),
  ])
  const [vGrill, vPrep, vBar] = await Promise.all([
    upsertStation('Grill',  viva.id, '#6C3EE8'),
    upsertStation('Prep',   viva.id, '#22c55e'),
    upsertStation('Bar',    viva.id, '#06b6d4'),
  ])
  console.log('   ✓ Stations created for all 5 concepts')

  // ── 4. Menu Items ─────────────────────────────────────────────────────────

  console.log('4/14  Menu items...')

  async function cat(name: string, conceptId: string, pos: number) {
    const ex = await prisma.category.findFirst({ where: { name, conceptId } })
    if (ex) return ex
    return prisma.category.create({ data: { name, conceptId, sortOrder: pos } })
  }

  async function item(data: {
    name: string; conceptId: string; categoryId: string; priceCents: number
    stationId?: string; description?: string; isAvailable?: boolean
  }) {
    const ex = await prisma.menuItem.findFirst({ where: { name: data.name, conceptId: data.conceptId } })
    if (ex) return ex
    return prisma.menuItem.create({
      data: { ...data, isAvailable: data.isAvailable ?? true },
    })
  }

  // STAX menu
  const staxBurger = await cat('Burgers', stax.id, 1)
  const staxSides  = await cat('Sides', stax.id, 2)
  const staxDrinks = await cat('Drinks', stax.id, 3)
  const [staxClassic, staxDouble, staxSpicy, staxMushroom] = await Promise.all([
    item({ name: 'Classic Smash', conceptId: stax.id, categoryId: staxBurger.id, priceCents: 89000, stationId: stGrill?.id, description: 'Double smash patty, american cheese, house sauce, pickles, brioche' }),
    item({ name: 'Double Trouble', conceptId: stax.id, categoryId: staxBurger.id, priceCents: 129000, stationId: stGrill?.id, description: '2×smash, double cheese, caramelised onions, signature sauce' }),
    item({ name: 'Spicy Señorita', conceptId: stax.id, categoryId: staxBurger.id, priceCents: 99000, stationId: stGrill?.id, description: 'Smash patty, jalapeños, chipotle mayo, pepper jack' }),
    item({ name: 'Mushroom Melt', conceptId: stax.id, categoryId: staxBurger.id, priceCents: 109000, stationId: stGrill?.id, description: 'Smash patty, sautéed mushrooms, truffle aioli, swiss' }),
  ])
  const [staxFries, staxWaffle, staxShake] = await Promise.all([
    item({ name: 'Loaded Fries',   conceptId: stax.id, categoryId: staxSides.id,  priceCents: 49000, stationId: stFry?.id }),
    item({ name: 'Waffle Fries',   conceptId: stax.id, categoryId: staxSides.id,  priceCents: 39000, stationId: stFry?.id }),
    item({ name: 'Signature Shake',conceptId: stax.id, categoryId: staxDrinks.id, priceCents: 59000 }),
  ])

  // SIMMER menu
  const simmSmall   = await cat('Small Plates', simmer.id, 1)
  const simmMains   = await cat('Mains', simmer.id, 2)
  const simmMocktail= await cat('Mocktails', simmer.id, 3)
  const simmDessert = await cat('Desserts', simmer.id, 4)
  const [simmBruschetta, simmTartare, simmMushTart, simmLambRack, simmSeaBass, simmRisotto] = await Promise.all([
    item({ name: 'Burrata Bruschetta', conceptId: simmer.id, categoryId: simmSmall.id,  priceCents: 69000, stationId: sPlating?.id }),
    item({ name: 'Tuna Tartare',       conceptId: simmer.id, categoryId: simmSmall.id,  priceCents: 89000, stationId: sPlating?.id }),
    item({ name: 'Wild Mushroom Tart', conceptId: simmer.id, categoryId: simmSmall.id,  priceCents: 75000, stationId: sPlating?.id }),
    item({ name: 'Lamb Rack',          conceptId: simmer.id, categoryId: simmMains.id,  priceCents: 189000, stationId: sGrill?.id }),
    item({ name: 'Sea Bass Fillet',    conceptId: simmer.id, categoryId: simmMains.id,  priceCents: 165000, stationId: sGrill?.id }),
    item({ name: 'Truffle Risotto',    conceptId: simmer.id, categoryId: simmMains.id,  priceCents: 149000, stationId: sPrep?.id }),
  ])
  const [simmVirginMojito, simmPassion, simmLavender, simmCreme] = await Promise.all([
    item({ name: 'Virgin Mojito',  conceptId: simmer.id, categoryId: simmMocktail.id, priceCents: 45000 }),
    item({ name: 'Passion Cooler', conceptId: simmer.id, categoryId: simmMocktail.id, priceCents: 49000 }),
    item({ name: 'Lavender Lemon', conceptId: simmer.id, categoryId: simmMocktail.id, priceCents: 52000 }),
    item({ name: 'Crème Brûlée',   conceptId: simmer.id, categoryId: simmDessert.id,  priceCents: 59000, stationId: sPlating?.id }),
  ])

  // FLIPD menu
  const flipdChicken = await cat('Chicken', flipd.id, 1)
  const flipdSides   = await cat('Sides', flipd.id, 2)
  const flipdDrinks  = await cat('Drinks', flipd.id, 3)
  const [flipdCrispy, flipdStrip, flipdSlider, flipdFries, flipdColeslaw] = await Promise.all([
    item({ name: 'Crispy Chicken Sandwich', conceptId: flipd.id, categoryId: flipdChicken.id, priceCents: 79000, stationId: fFry?.id }),
    item({ name: 'Chicken Strips (5pc)',    conceptId: flipd.id, categoryId: flipdChicken.id, priceCents: 69000, stationId: fFry?.id }),
    item({ name: 'Chicken Slider Box (3)',  conceptId: flipd.id, categoryId: flipdChicken.id, priceCents: 89000, stationId: fFry?.id }),
    item({ name: 'Seasoned Fries',          conceptId: flipd.id, categoryId: flipdSides.id,   priceCents: 35000, stationId: fFry?.id }),
    item({ name: 'Creamy Coleslaw',         conceptId: flipd.id, categoryId: flipdSides.id,   priceCents: 25000 }),
  ])

  // STRATA menu
  const strataBowls = await cat('Protein Bowls', strata.id, 1)
  const strataWraps = await cat('Wraps', strata.id, 2)
  const strataDrinks= await cat('Drinks', strata.id, 3)
  const [strataChickenBowl, strataTunaBowl, strataBeefWrap, strataProteinShake] = await Promise.all([
    item({ name: 'Grilled Chicken Bowl',  conceptId: strata.id, categoryId: strataBowls.id, priceCents: 79000, stationId: trGrill?.id, description: '180g chicken, brown rice, roasted veg, tahini — 48g protein' }),
    item({ name: 'Seared Tuna Bowl',      conceptId: strata.id, categoryId: strataBowls.id, priceCents: 95000, stationId: trGrill?.id, description: '160g tuna, quinoa, edamame, ginger ponzu — 52g protein' }),
    item({ name: 'Beef & Hummus Wrap',    conceptId: strata.id, categoryId: strataWraps.id, priceCents: 85000, stationId: trGrill?.id }),
    item({ name: 'Whey Protein Shake',    conceptId: strata.id, categoryId: strataDrinks.id, priceCents: 45000 }),
  ])

  // GS x VIVA menu
  const vivaClub   = await cat('Club Bites', viva.id, 1)
  const vivaMains  = await cat('Mains', viva.id, 2)
  const vivaJuices = await cat('Fresh Juices', viva.id, 3)
  const vivaShakes = await cat('Shakes', viva.id, 4)
  const [vivaNachos, vivaWings, vivaPizza, vivaBurger, vivaSalad, vivaGreenJuice, vivaMango, vivaAvocadoToast] = await Promise.all([
    item({ name: 'Club Nachos',      conceptId: viva.id, categoryId: vivaClub.id,   priceCents: 89000, stationId: vPrep?.id }),
    item({ name: 'Spiced Wings (8)', conceptId: viva.id, categoryId: vivaClub.id,   priceCents: 99000, stationId: vGrill?.id }),
    item({ name: 'Club Pizza',       conceptId: viva.id, categoryId: vivaMains.id,  priceCents: 149000, stationId: vGrill?.id }),
    item({ name: 'Padel Burger',     conceptId: viva.id, categoryId: vivaMains.id,  priceCents: 119000, stationId: vGrill?.id, description: 'Named after the sport — smoky, bold, loaded' }),
    item({ name: 'Recovery Salad',   conceptId: viva.id, categoryId: vivaMains.id,  priceCents: 79000, stationId: vPrep?.id }),
    item({ name: 'Green Detox Juice',conceptId: viva.id, categoryId: vivaJuices.id, priceCents: 49000, stationId: vBar?.id }),
    item({ name: 'Mango Lassi',      conceptId: viva.id, categoryId: vivaJuices.id, priceCents: 45000, stationId: vBar?.id }),
    item({ name: 'Avocado Toast',    conceptId: viva.id, categoryId: vivaMains.id,  priceCents: 89000, stationId: vPrep?.id }),
  ])

  console.log('   ✓ Full menus for all 5 concepts')

  // ── 5. Tables (Simmer + GS x Viva) ───────────────────────────────────────

  console.log('5/14  Tables...')

  async function upsertTable(label: string, conceptId: string, capacity: number, _locationId: string) {
    const ex = await prisma.table.findFirst({ where: { label, conceptId } })
    if (ex) return ex
    return prisma.table.create({ data: { label, conceptId, capacity, status: 'available' } })
  }

  const locationId   = '7e9cbc66-cf6d-4018-9c7e-7a462ec093b8' // Bukhari
  const vivaLocId    = '71fe2d21-0515-460d-a546-eecfc6a0ef26' // Viva Padel Club

  const simmerTables = await Promise.all([
    upsertTable('T1', simmer.id, 2, locationId),
    upsertTable('T2', simmer.id, 2, locationId),
    upsertTable('T3', simmer.id, 4, locationId),
    upsertTable('T4', simmer.id, 4, locationId),
    upsertTable('T5', simmer.id, 6, locationId),
    upsertTable('Bar', simmer.id, 4, locationId),
  ])

  const vivaTables = await Promise.all([
    upsertTable('V1', viva.id, 2, vivaLocId),
    upsertTable('V2', viva.id, 2, vivaLocId),
    upsertTable('V3', viva.id, 4, vivaLocId),
    upsertTable('V4', viva.id, 4, vivaLocId),
    upsertTable('Court-Side', viva.id, 6, vivaLocId),
    upsertTable('Lounge', viva.id, 8, vivaLocId),
  ])

  console.log('   ✓ 6 tables each for Simmer + GS x Viva')

  // ── 6. Inventory ──────────────────────────────────────────────────────────

  console.log('6/14  Inventory...')

  async function inv(name: string, unit: string, currentStock: number, parLevel: number, unitCostCents: number) {
    const ex = await prisma.inventoryItem.findFirst({ where: { name } })
    if (ex) return ex
    return prisma.inventoryItem.create({
      data: { name, unit, currentStock, parLevel, unitCostCents },
    })
  }

  await Promise.all([
    inv('Beef Patty (120g)',     'kg',  4.8,  10,  85000),  // LOW STOCK
    inv('Brioche Bun',          'pcs', 45,   50,  12000),  // LOW STOCK
    inv('Chicken Breast',       'kg',  12,   8,   65000),
    inv('Chicken Thigh (bone)', 'kg',  8,    6,   55000),
    inv('Cheddar Cheese Slice', 'pcs', 120,  80,   3500),
    inv('Lettuce Head',         'pcs', 18,   12,   8000),
    inv('Tomato',               'kg',  6,    4,   15000),
    inv('Jalapeño',             'kg',  2,    1.5, 30000),
    inv('Truffle Oil',          'ltr', 0.8,  1,   450000), // LOW STOCK
    inv('Lamb Rack',            'kg',  3.2,  4,   380000), // LOW STOCK
    inv('Sea Bass Fillet',      'kg',  4,    3,   280000),
    inv('Arborio Rice',         'kg',  5,    3,   35000),
    inv('Quinoa',               'kg',  3,    2,   55000),
    inv('Fresh Mozzarella',     'kg',  2,    1.5, 95000),
    inv('Canola Oil',           'ltr', 18,   10,   8000),
    inv('Mayonnaise',           'kg',  4,    3,   25000),
    inv('Chipotle Sauce',       'kg',  1.5,  1,   45000),
    inv('Buttermilk',           'ltr', 6,    4,   12000),
    inv('Breadcrumbs (Panko)',  'kg',  3,    2,   18000),
    inv('Avocado',              'pcs', 24,   20,  25000),
  ])

  console.log('   ✓ 20 inventory items (4 flagged low stock)')

  // ── 7. Kitchen Staff ──────────────────────────────────────────────────────

  console.log('7/14  Kitchen staff...')

  async function ks(data: {
    fullName: string; cnic: string; phone: string; kitchenRole: string; skillLevel: string
    employmentType: string; monthlySalaryCash: number; mealsProvided?: boolean; emergencyContact: string
  }) {
    const ex = await prisma.kitchenStaff.findFirst({ where: { tenantId: TENANT_ID, cnic: data.cnic } })
    if (ex) return ex
    return prisma.kitchenStaff.create({
      data: {
        ...data as any,
        tenantId: TENANT_ID,
        dateJoined: daysAgo(Math.floor(Math.random() * 365 + 90)),
        status: 'active',
        mealsProvided: data.mealsProvided ?? true,
        eobiRegistered: data.monthlySalaryCash >= 40000,
        sessiRegistered: data.monthlySalaryCash >= 40000,
        emergencyContact: data.emergencyContact,
      },
    })
  }

  const [headChef, sousChef, cdp1, cdp2, commis1, commis2, commis3, helper1, helper2, dishwasher1, dishwasher2] = await Promise.all([
    ks({ fullName: 'Chef Bilal Raza',     cnic: '42101-5234567-1', phone: '0300-1234567', kitchenRole: 'head_chef',     skillLevel: 'highly_skilled', employmentType: 'permanent',  monthlySalaryCash: 85000, emergencyContact: '0300-9876543' }),
    ks({ fullName: 'Chef Kamran Aslam',   cnic: '42201-6345678-2', phone: '0301-2345678', kitchenRole: 'sous_chef',     skillLevel: 'highly_skilled', employmentType: 'permanent',  monthlySalaryCash: 68000, emergencyContact: '0301-8765432' }),
    ks({ fullName: 'Imran Hussain',       cnic: '42301-7456789-3', phone: '0302-3456789', kitchenRole: 'cdp',           skillLevel: 'skilled',        employmentType: 'permanent',  monthlySalaryCash: 52000, emergencyContact: '0302-7654321' }),
    ks({ fullName: 'Waqas Ali',           cnic: '42401-8567890-4', phone: '0303-4567890', kitchenRole: 'cdp',           skillLevel: 'skilled',        employmentType: 'permanent',  monthlySalaryCash: 50000, emergencyContact: '0303-6543210' }),
    ks({ fullName: 'Usman Tariq',         cnic: '42501-9678901-5', phone: '0304-5678901', kitchenRole: 'commis',        skillLevel: 'semi_skilled',   employmentType: 'permanent',  monthlySalaryCash: 43000, emergencyContact: '0304-5432109' }),
    ks({ fullName: 'Zain Qureshi',        cnic: '42601-0789012-6', phone: '0305-6789012', kitchenRole: 'commis',        skillLevel: 'semi_skilled',   employmentType: 'permanent',  monthlySalaryCash: 42000, emergencyContact: '0305-4321098' }),
    ks({ fullName: 'Hamza Sheikh',        cnic: '42701-1890123-7', phone: '0306-7890123', kitchenRole: 'commis',        skillLevel: 'semi_skilled',   employmentType: 'probationary', monthlySalaryCash: 42000, emergencyContact: '0306-3210987' }),
    ks({ fullName: 'Rizwan Ansari',       cnic: '42801-2901234-8', phone: '0307-8901234', kitchenRole: 'kitchen_helper', skillLevel: 'unskilled',     employmentType: 'permanent',  monthlySalaryCash: 40500, emergencyContact: '0307-2109876' }),
    ks({ fullName: 'Nasir Mehmood',       cnic: '42901-3012345-9', phone: '0308-9012345', kitchenRole: 'kitchen_helper', skillLevel: 'unskilled',     employmentType: 'contract',   monthlySalaryCash: 40000, emergencyContact: '0308-1098765' }),
    ks({ fullName: 'Asif Rehman',         cnic: '41101-4123456-0', phone: '0309-0123456', kitchenRole: 'dishwasher',    skillLevel: 'unskilled',      employmentType: 'permanent',  monthlySalaryCash: 40000, emergencyContact: '0309-0987654' }),
    ks({ fullName: 'Khalid Mahmood',      cnic: '41201-5234567-0', phone: '0310-1234567', kitchenRole: 'dishwasher',    skillLevel: 'unskilled',      employmentType: 'permanent',  monthlySalaryCash: 40000, emergencyContact: '0310-9876543' }),
  ])

  // Viva-specific (smaller brigade)
  const [vivaChef, vivaCommis, vivaHelper] = await Promise.all([
    ks({ fullName: 'Chef Sana Malik',    cnic: '42101-6345678-3', phone: '0311-2345678', kitchenRole: 'cdp',           skillLevel: 'skilled',      employmentType: 'permanent',  monthlySalaryCash: 55000, emergencyContact: '0311-1234567' }),
    ks({ fullName: 'Junaid Akhtar',      cnic: '42201-7456789-4', phone: '0312-3456789', kitchenRole: 'commis',        skillLevel: 'semi_skilled', employmentType: 'permanent',  monthlySalaryCash: 42000, emergencyContact: '0312-2345678' }),
    ks({ fullName: 'Shahbaz Gul',        cnic: '42301-8567890-5', phone: '0313-4567890', kitchenRole: 'kitchen_helper', skillLevel: 'unskilled',   employmentType: 'permanent',  monthlySalaryCash: 40000, emergencyContact: '0313-3456789' }),
  ])

  const allKitchenStaff = [headChef, sousChef, cdp1, cdp2, commis1, commis2, commis3, helper1, helper2, dishwasher1, dishwasher2, vivaChef, vivaCommis, vivaHelper]
  console.log(`   ✓ ${allKitchenStaff.length} kitchen staff`)

  // ── 8. Wage Settings ──────────────────────────────────────────────────────

  console.log('8/14  Wage settings...')

  await prisma.wageSettings.upsert({
    where: { tenantId: TENANT_ID },
    update: {},
    create: {
      tenantId: TENANT_ID,
      minWageUnskilled: 40000, minWageSemiSkilled: 41280,
      minWageSkilled: 48910, minWageHighlySkilled: 50868,
      workingDaysPerMonth: 26, paidHoursPerDay: 8,
      otMultiplierRegular: 2.0, otMultiplierFestival: 3.0,
      maxOtHoursPerWeek: 12, maxOtHoursPerYear: 624,
      eobiEmployerPct: 0.01, sessiEmployerPct: 0.06,
    },
  })

  console.log('   ✓ Sindh FY 2025-26 wage settings')

  // ── 9. Riders ─────────────────────────────────────────────────────────────

  console.log('9/14  Riders...')

  async function rider(name: string, phone: string, vehicle: string, status: string, lat: number, lng: number) {
    const ex = await prisma.rider.findFirst({ where: { phone } })
    if (ex) {
      await prisma.rider.update({ where: { id: ex.id }, data: { status: status as any, lastLat: lat, lastLng: lng, lastReportedAt: new Date() } })
      return ex
    }
    return prisma.rider.create({
      data: {
        name, phone, vehicleType: vehicle as any,
        status: status as any, isActive: true,
        lastLat: lat, lastLng: lng, lastReportedAt: new Date(),
      },
    })
  }

  const [riderAli, riderUmar, riderBilal] = await Promise.all([
    rider('Ali Hassan',     '0321-1111111', 'bike', 'available',  24.8205, 67.0765),
    rider('Umar Farooq',    '0321-2222222', 'bike', 'busy', 24.8152, 67.0698),
    rider('Bilal Aslam',    '0321-3333333', 'bike', 'available',  24.8231, 67.0789),
  ])

  console.log('   ✓ 3 riders (2 available, 1 on delivery)')

  // ── 10. Customers ─────────────────────────────────────────────────────────

  console.log('10/14  Customers...')

  interface CustomerRow { id: string; name: string }

  async function customer(name: string, phone: string, email: string, totalSpentCents: number, lastOrderAt: Date): Promise<CustomerRow> {
    const ex = await prisma.customer.findFirst({ where: { phone } })
    if (ex) return ex
    const pts = Math.floor(totalSpentCents / 10000)
    const c = await prisma.customer.create({
      data: {
        name, phone, email,
        totalSpentCents, lastOrderAt, firstOrderAt: daysAgo(90),
        marketingOptIn: true, avgReviewRating: 4 + Math.random() * 0.9,
        lastVisitAt: lastOrderAt,
      },
    })
    // Loyalty account — one per company (@@unique([tenantId, customerId])),
    // in the seeded brands' company; none when the brand has no company.
    const tenantId = simmer.tenantId
    if (tenantId) {
      await prisma.loyaltyAccount.upsert({
        where: { tenantId_customerId: { tenantId, customerId: c.id } },
        update: {},
        create: { tenantId, customerId: c.id, pointsBalance: pts, lifetimePoints: pts, stampCounts: {} },
      })
    }
    return c
  }

  const [cAhmed, cSara, cOmar, cFatima, cZara, cHassan, cMaria, cImran, cAyesha, cDanish] = await Promise.all([
    customer('Ahmed Siddiqui',    '0300-1111111', 'ahmed.siddiqui@gmail.com',    485000, daysAgo(1)),
    customer('Sara Khan',          '0300-2222222', 'sara.khan@gmail.com',         320000, daysAgo(2)),
    customer('Omar Farooq',        '0300-3333333', 'omar.farooq@gmail.com',       610000, daysAgo(0, 13)),
    customer('Fatima Malik',       '0300-4444444', 'fatima.malik@gmail.com',      175000, daysAgo(3)),
    customer('Zara Hussain',       '0300-5555555', 'zara.hussain@gmail.com',      890000, daysAgo(0, 11)),
    customer('Hassan Ali',         '0300-6666666', 'hassan.ali@gmail.com',        240000, daysAgo(5)),
    customer('Maria Sheikh',       '0300-7777777', 'maria.sheikh@gmail.com',     1250000, daysAgo(0, 14)),
    customer('Imran Qureshi',      '0300-8888888', 'imran.qureshi@gmail.com',     95000, daysAgo(7)),
    customer('Ayesha Baig',        '0300-9999999', 'ayesha.baig@gmail.com',      430000, daysAgo(0, 16)),
    customer('Danish Ahmed',       '0301-1111111', 'danish.ahmed@gmail.com',     760000, daysAgo(0, 10)),
  ])

  const customers = [cAhmed, cSara, cOmar, cFatima, cZara, cHassan, cMaria, cImran, cAyesha, cDanish]
  console.log(`   ✓ ${customers.length} customers with loyalty accounts`)

  // ── 11. POS Shifts (open right now) ──────────────────────────────────────

  console.log('11/14  POS shifts (live)...')

  // Close any stale open shifts first
  await prisma.shift.updateMany({
    where: { status: 'open', openedAt: { lt: today(0) } },
    data: { status: 'closed', closedAt: today(1), closingFloatCents: 500000 },
  })

  async function openPosShift(userId: string) {
    const existing = await prisma.shift.findFirst({ where: { userId, status: 'open' } })
    if (existing) return existing
    return prisma.shift.create({
      data: {
        userId, locationId,
        status: 'open',
        openedAt: today(11), // opened at 11am PKT
        openingFloatCents: 500000,
      },
    })
  }

  const shiftManager  = await openPosShift(manager.id)
  const shiftCashier1 = await openPosShift(cashier1.id)
  const shiftCashier2 = await openPosShift(cashier2.id)

  console.log('   ✓ 3 POS shifts open (Manager + 2 Cashiers)')

  // ── 12. Today's Live Orders ───────────────────────────────────────────────

  console.log('12/14  Live orders...')

  let orderCount = 0

  async function order(data: {
    conceptId: string; source: string; status: string; items: { menuItemId: string; name: string; qty: number; priceCents: number }[]
    customerId?: string; customerName?: string; tableId?: string
    placedAt?: Date; payMethod?: string; shiftId?: string
  }) {
    const totalCents = data.items.reduce((s, i) => s + i.priceCents * i.qty, 0)
    const taxCents   = Math.round(totalCents * 0.17)
    const grandTotal = totalCents + taxCents

    const ord = await prisma.order.create({
      data: {
        source:       data.source as any,
        status:       data.status as any,
        conceptId:    data.conceptId,
        customerId:   data.customerId,
        customerName: data.customerName ?? null,
        tableId:      data.tableId,
        totalCents:   grandTotal,
        taxCents,
        placedAt:     data.placedAt ?? new Date(),
        shiftId:      data.shiftId,
        posStaffId:   data.shiftId ? manager.id : null,
        locationId,
      },
    })
    for (const i of data.items) {
      await prisma.orderItem.create({
        data: {
          orderId: ord.id, menuItemId: i.menuItemId,
          name: i.name, quantity: i.qty, unitPriceCents: i.priceCents,
          status: data.status === 'completed' ? 'bumped' : 'pending',
          course: 1,
        },
      })
    }
    if (data.status === 'completed' && data.payMethod) {
      await prisma.payment.create({
        data: {
          orderId: ord.id, shiftId: data.shiftId,
          method: data.payMethod as any, amountCents: grandTotal,
          status: 'paid', processedAt: data.placedAt ?? new Date(),
        },
      })
    }
    orderCount++
    return ord
  }

  // Completed orders from this morning
  await order({ conceptId: stax.id, source: 'pos', status: 'completed', shiftId: shiftCashier1.id,
    placedAt: today(12, 30), payMethod: 'cash', customerId: cAhmed.id, customerName: cAhmed.name,
    items: [{ menuItemId: staxClassic.id, name: staxClassic.name, qty: 2, priceCents: 89000 },
            { menuItemId: staxFries.id,   name: staxFries.name,   qty: 2, priceCents: 49000 }] })

  await order({ conceptId: stax.id, source: 'pos', status: 'completed', shiftId: shiftCashier1.id,
    placedAt: today(13, 15), payMethod: 'card', customerId: cSara.id, customerName: cSara.name,
    items: [{ menuItemId: staxDouble.id,  name: staxDouble.name,  qty: 1, priceCents: 129000 },
            { menuItemId: staxShake.id,   name: staxShake.name,   qty: 1, priceCents: 59000 }] })

  await order({ conceptId: flipd.id, source: 'foodpanda', status: 'completed',
    placedAt: today(13, 0), payMethod: 'card', customerName: 'Foodpanda Order',
    items: [{ menuItemId: flipdCrispy.id, name: flipdCrispy.name, qty: 2, priceCents: 79000 },
            { menuItemId: flipdFries.id,  name: flipdFries.name,  qty: 1, priceCents: 35000 }] })

  await order({ conceptId: strata.id, source: 'servd', status: 'completed',
    placedAt: today(13, 45), customerId: cMaria.id, customerName: cMaria.name,
    items: [{ menuItemId: strataChickenBowl.id, name: strataChickenBowl.name, qty: 1, priceCents: 79000 }] })

  // Lunch dine-in at Simmer
  await order({ conceptId: simmer.id, source: 'pos', status: 'completed', shiftId: shiftManager.id,
    placedAt: today(13, 0), payMethod: 'card', tableId: simmerTables[2]?.id, customerId: cZara.id, customerName: cZara.name,
    items: [{ menuItemId: simmBruschetta.id, name: simmBruschetta.name, qty: 2, priceCents: 69000 },
            { menuItemId: simmLambRack.id,   name: simmLambRack.name,   qty: 2, priceCents: 189000 },
            { menuItemId: simmVirginMojito.id, name: simmVirginMojito.name, qty: 2, priceCents: 45000 }] })

  // LIVE — orders currently in kitchen
  const liveStax1 = await order({ conceptId: stax.id, source: 'pos', status: 'preparing', shiftId: shiftCashier1.id,
    placedAt: today(19, 15), customerId: cOmar.id, customerName: cOmar.name,
    items: [{ menuItemId: staxSpicy.id,   name: staxSpicy.name,   qty: 1, priceCents: 99000 },
            { menuItemId: staxWaffle.id,  name: staxWaffle.name,  qty: 1, priceCents: 39000 },
            { menuItemId: staxShake.id,   name: staxShake.name,   qty: 1, priceCents: 59000 }] })

  const liveStax2 = await order({ conceptId: stax.id, source: 'careem', status: 'confirmed',
    placedAt: today(19, 22), customerName: 'Careem Order #8821',
    items: [{ menuItemId: staxClassic.id, name: staxClassic.name, qty: 3, priceCents: 89000 },
            { menuItemId: staxFries.id,   name: staxFries.name,   qty: 3, priceCents: 49000 }] })

  const liveFlipd = await order({ conceptId: flipd.id, source: 'foodpanda', status: 'preparing',
    placedAt: today(19, 10), customerName: 'Foodpanda Order #2234',
    items: [{ menuItemId: flipdSlider.id,  name: flipdSlider.name,  qty: 2, priceCents: 89000 },
            { menuItemId: flipdColeslaw.id, name: flipdColeslaw.name, qty: 2, priceCents: 25000 }] })

  // Live dine-in at Simmer (evening service)
  const liveSimmer1 = await order({ conceptId: simmer.id, source: 'pos', status: 'preparing', shiftId: shiftManager.id,
    placedAt: today(19, 0), tableId: simmerTables[0]?.id, customerId: cDanish.id, customerName: cDanish.name,
    items: [{ menuItemId: simmTartare.id,   name: simmTartare.name,   qty: 1, priceCents: 89000 },
            { menuItemId: simmSeaBass.id,   name: simmSeaBass.name,   qty: 2, priceCents: 165000 },
            { menuItemId: simmPassion.id,   name: simmPassion.name,   qty: 2, priceCents: 49000 }] })

  const liveSimmer2 = await order({ conceptId: simmer.id, source: 'pos', status: 'confirmed', shiftId: shiftManager.id,
    placedAt: today(19, 25), tableId: simmerTables[4]?.id, customerName: 'Walk-in Table 5',
    items: [{ menuItemId: simmMushTart.id,  name: simmMushTart.name,  qty: 2, priceCents: 75000 },
            { menuItemId: simmRisotto.id,   name: simmRisotto.name,   qty: 2, priceCents: 149000 },
            { menuItemId: simmLavender.id,  name: simmLavender.name,  qty: 2, priceCents: 52000 }] })

  // Live at Viva
  const liveViva1 = await order({ conceptId: viva.id, source: 'pos', status: 'preparing', shiftId: shiftCashier2.id,
    placedAt: today(18, 45), tableId: vivaTables[4]?.id, customerId: cAyesha.id, customerName: cAyesha.name,
    items: [{ menuItemId: vivaWings.id,  name: vivaWings.name,  qty: 2, priceCents: 99000 },
            { menuItemId: vivaPizza.id,  name: vivaPizza.name,  qty: 1, priceCents: 149000 },
            { menuItemId: vivaGreenJuice.id, name: vivaGreenJuice.name, qty: 2, priceCents: 49000 }] })

  const liveViva2 = await order({ conceptId: viva.id, source: 'pos', status: 'received', shiftId: shiftCashier2.id,
    placedAt: today(19, 28), tableId: vivaTables[5]?.id, customerName: 'Court-Side Lounge',
    items: [{ menuItemId: vivaNachos.id,    name: vivaNachos.name,    qty: 2, priceCents: 89000 },
            { menuItemId: vivaBurger.id,    name: vivaBurger.name,    qty: 3, priceCents: 119000 },
            { menuItemId: vivaMango.id,     name: vivaMango.name,     qty: 3, priceCents: 45000 }] })

  // Update table statuses for occupied tables
  await prisma.table.updateMany({
    where: { id: { in: [simmerTables[0]?.id, simmerTables[4]?.id, vivaTables[4]?.id, vivaTables[5]?.id].filter(Boolean) as string[] } },
    data: { status: 'occupied' },
  })

  console.log(`   ✓ ${orderCount} orders (5 completed earlier, 8 live/active now)`)

  // ── 13. Kitchen Shifts (last 14 days + today punched in) ──────────────────

  console.log('13/14  Kitchen shifts...')

  let shiftCount = 0
  const mainBrigade = [headChef, sousChef, cdp1, cdp2, commis1, commis2, commis3, helper1, helper2, dishwasher1, dishwasher2]
  const vivaBrigade = [vivaChef, vivaCommis, vivaHelper]

  for (let dayOffset = 13; dayOffset >= 0; dayOffset--) {
    const dayDate = dateOnly(-dayOffset)
    const isWeekend = dayDate.getDay() === 5 || dayDate.getDay() === 6 // Fri/Sat
    const isTodayShift = dayOffset === 0

    for (const [i, staff] of mainBrigade.entries()) {
      const dayOff = (i + dayOffset) % 7 === 6  // stagger days off so never everyone off
      if (dayOff) {
        await prisma.kitchenShift.upsert({
          where: { staffId_date: { staffId: staff.id, date: dayDate } },
          update: {},
          create: { staffId: staff.id, date: dayDate, scheduledStart: '00:00', scheduledEnd: '00:00', isWeeklyOff: true, breakMinutes: 0 },
        }).catch(() => null)
        continue
      }
      const start = i < 5 ? '11:00' : '14:00'  // morning vs PM brigade
      const end   = i < 5 ? '23:00' : '24:00'
      const actualStart = isTodayShift ? (i < 5 ? '10:55' : '13:58') : (i < 5 ? '10:58' : '14:02')
      const actualEnd   = isTodayShift ? null : (i < 5 ? '23:05' : '23:58')
      await prisma.kitchenShift.upsert({
        where: { staffId_date: { staffId: staff.id, date: dayDate } },
        update: {},
        create: {
          staffId: staff.id, date: dayDate,
          scheduledStart: start, scheduledEnd: end, breakMinutes: 60,
          actualStart, actualEnd: actualEnd ?? undefined,
          isFestivalHoliday: false,
        },
      }).catch(() => null)
      shiftCount++
    }

    for (const [i, staff] of vivaBrigade.entries()) {
      const start = '14:00'; const end = '23:00'
      const actualStart = isTodayShift ? '13:55' : '14:02'
      const actualEnd   = isTodayShift ? null : '23:10'
      await prisma.kitchenShift.upsert({
        where: { staffId_date: { staffId: staff.id, date: dayDate } },
        update: {},
        create: { staffId: staff.id, date: dayDate, scheduledStart: start, scheduledEnd: end, breakMinutes: 60, actualStart, actualEnd: actualEnd ?? undefined },
      }).catch(() => null)
      shiftCount++
    }
  }

  console.log(`   ✓ ${shiftCount} kitchen shifts (last 14 days, today punched in)`)

  // ── 14. Reservations ──────────────────────────────────────────────────────

  console.log('14a/14  Reservations...')

  async function reservation(data: {
    conceptId: string; customerId: string; guestName: string; partySize: number
    startTime: Date; endTime: Date; tableId?: string; notes?: string
  }) {
    const ex = await prisma.reservation.findFirst({
      where: { conceptId: data.conceptId, customerId: data.customerId, startTime: { gte: dateOnly(-1) } }
    })
    if (ex) return ex
    return prisma.reservation.create({
      data: {
        conceptId: data.conceptId, customerId: data.customerId,
        guestName: data.guestName, guestPhone: '0300-0000000',
        partySize: data.partySize,
        startTime: data.startTime, endTime: data.endTime,
        tableId: data.tableId,
        notes: data.notes ?? null,
        status: 'booked', source: 'staff',
        depositCents: 0,
      },
    })
  }

  await Promise.all([
    // Tonight at Simmer
    reservation({ conceptId: simmer.id, customerId: cFatima.id, guestName: cFatima.name,
      partySize: 4, startTime: today(20, 0), endTime: today(21, 30), tableId: simmerTables[3]?.id,
      notes: 'Birthday dinner — please arrange a surprise dessert' }),
    reservation({ conceptId: simmer.id, customerId: cHassan.id, guestName: cHassan.name,
      partySize: 2, startTime: today(20, 30), endTime: today(22, 0), tableId: simmerTables[1]?.id }),
    // Tomorrow at Viva
    reservation({ conceptId: viva.id, customerId: cOmar.id, guestName: cOmar.name,
      partySize: 6, startTime: tomorrow(19, 0), endTime: tomorrow(21, 0), tableId: vivaTables[4]?.id,
      notes: 'Post-tournament dinner, 6 players' }),
    // Tomorrow at Simmer
    reservation({ conceptId: simmer.id, customerId: cMaria.id, guestName: cMaria.name,
      partySize: 8, startTime: tomorrow(19, 30), endTime: tomorrow(22, 0), tableId: simmerTables[4]?.id,
      notes: 'Corporate team dinner' }),
  ])
  console.log('   ✓ 4 reservations (2 tonight, 2 tomorrow)')

  // ── Reviews ──────────────────────────────────────────────────────────────

  // Create placeholder "past" orders for reviews (OrderReview requires unique orderId)
  async function pastOrder(conceptId: string, customerId: string, daysBack: number) {
    const ex = await prisma.order.findFirst({ where: { conceptId, customerId, status: 'completed', placedAt: { lt: today(0) } }, orderBy: { placedAt: 'desc' } })
    if (ex) return ex
    const o = await prisma.order.create({
      data: { source: 'servd', status: 'completed', conceptId, customerId, totalCents: 99000, taxCents: 14000, placedAt: daysAgo(daysBack), locationId },
    })
    return o
  }

  const [ro1, ro2, ro3, ro4, ro5, ro6, ro7] = await Promise.all([
    pastOrder(stax.id,   cAhmed.id,  1),
    pastOrder(stax.id,   cSara.id,   3),
    pastOrder(simmer.id, cZara.id,   2),
    pastOrder(simmer.id, cDanish.id, 4),
    pastOrder(flipd.id,  cOmar.id,   5),
    pastOrder(viva.id,   cAyesha.id, 1),
    pastOrder(strata.id, cMaria.id,  6),
  ])

  async function review(orderId: string, conceptId: string, customerId: string, rating: number, comment: string) {
    const ex = await prisma.orderReview.findFirst({ where: { orderId } })
    if (ex) return ex
    return prisma.orderReview.create({ data: { orderId, conceptId, customerId, rating, comment } })
  }

  await Promise.all([
    review(ro1.id, stax.id,   cAhmed.id,  5, 'Best smash burgers in DHA, no competition. Classic Smash with loaded fries is the go-to.'),
    review(ro2.id, stax.id,   cSara.id,   4, 'Double Trouble hit different. Could use more pickles but otherwise perfect.'),
    review(ro3.id, simmer.id, cZara.id,   5, 'Lamb rack was flawless. The mocktail menu is seriously creative. Will be back every week.'),
    review(ro4.id, simmer.id, cDanish.id, 4, 'Sea bass was cooked beautifully. Truffle risotto was a bit salty but overall excellent.'),
    review(ro5.id, flipd.id,  cOmar.id,   5, 'The crunch on that chicken sandwich is unreal. Never comes soggy. Delivery game is strong.'),
    review(ro6.id, viva.id,   cAyesha.id, 5, 'Love the Padel Burger — perfect after a match. Viva is now our go-to spot after games.'),
    review(ro7.id, strata.id, cMaria.id,  4, 'Exactly what I needed. Grilled chicken bowl with macros on the lid is so helpful. Need more variety soon.'),
  ])

  // One complaint
  const recentOrder = await prisma.order.findFirst({ where: { conceptId: stax.id, status: 'completed' }, orderBy: { placedAt: 'desc' } })
  if (recentOrder) {
    const exComplaint = await prisma.orderComplaint.findFirst({ where: { conceptId: stax.id, customerId: cImran.id } })
    if (!exComplaint) {
      await prisma.orderComplaint.create({
        data: {
          orderId: recentOrder.id, conceptId: stax.id, customerId: cImran.id,
          title: 'Wrong item + cold fries',
          category: 'wrong_item', status: 'open', priority: 'medium',
          description: 'Received the Classic Smash instead of Spicy Señorita. Also the fries were barely warm.',
        },
      })
    }
  }

  console.log('   ✓ 7 reviews, 1 open complaint (wrong item at Stax)')

  // ── Payroll Run (April 2026) ──────────────────────────────────────────────

  const settings = await prisma.wageSettings.findUnique({ where: { tenantId: TENANT_ID } })
  if (settings) {
    for (const staff of allKitchenStaff) {
      const hr = staff.monthlySalaryCash / settings.workingDaysPerMonth / settings.paidHoursPerDay
      const regHours = settings.workingDaysPerMonth * settings.paidHoursPerDay * 0.92
      const otHours  = 8.5
      const otPay    = hr * settings.otMultiplierRegular * otHours
      const minWage  = staff.skillLevel === 'unskilled' ? settings.minWageUnskilled
                     : staff.skillLevel === 'semi_skilled' ? settings.minWageSemiSkilled
                     : staff.skillLevel === 'skilled' ? settings.minWageSkilled : settings.minWageHighlySkilled
      const eobi     = minWage * 0.01
      const sessi    = minWage * settings.sessiEmployerPct
      const gross    = staff.monthlySalaryCash + otPay + (staff.mealsProvided ? 5000 : 0)
      const net      = gross - eobi
      const trueCost = staff.monthlySalaryCash + otPay + (staff.mealsProvided ? 5000 : 0) + eobi + sessi

      await prisma.kitchenPayrollRun.upsert({
        where: { staffId_month_year: { staffId: staff.id, month: 4, year: 2026 } },
        update: {},
        create: {
          staffId: staff.id, tenantId: TENANT_ID, month: 4, year: 2026,
          baseSalary: staff.monthlySalaryCash, regularHoursWorked: regHours,
          otHoursRegular: otHours, otHoursFestival: 0, hourlyRate: hr,
          otPayRegular: otPay, otPayFestival: 0,
          mealValue: staff.mealsProvided ? 5000 : 0, accommodationValue: staff.accommodationValue,
          grossPay: gross, eobiEmployee: eobi, eobiEmployer: eobi, sessiEmployer: sessi,
          incomeTaxWithheld: 0, netPay: net, trueCostToCompany: trueCost, status: 'draft',
        },
      })
    }
    console.log(`   ✓ April 2026 payroll draft for ${allKitchenStaff.length} kitchen staff`)
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  console.log('\n━━━ Seed Complete ━━━')
  console.log('✅  5 concepts (Stax, Simmer, Flipd, Strata, GS x Viva)')
  console.log('✅  5 staff users + 14 kitchen brigade members')
  console.log('✅  Full menus across all 5 brands')
  console.log('✅  Tables for Simmer + GS x Viva')
  console.log('✅  20 inventory items (4 low-stock alerts)')
  console.log('✅  3 riders online')
  console.log('✅  10 customers with loyalty accounts')
  console.log('✅  3 POS shifts open right now')
  console.log('✅  8 live/active orders across all concepts')
  console.log('✅  14 days of kitchen shift history, today punched in')
  console.log('✅  4 upcoming reservations (2 tonight)')
  console.log('✅  7 customer reviews + 1 open complaint')
  console.log('✅  April 2026 payroll draft ready')
  console.log('\nLogin: admin@servd.pk / $SEED_STAFF_PASSWORD')
  console.log('       aamir.khan@servd.pk / $SEED_STAFF_PASSWORD (manager)\n')

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
