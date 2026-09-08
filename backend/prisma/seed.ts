import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.info('🌱 Seeding servd database...')

  // ─── Concepts ──────────────────────────────────────────────────────────────

  const simmer = await prisma.concept.upsert({
    where: { slug: 'simmer' },
    update: {
      name: 'Simmer',
      description: 'Fine-casual mocktail bar and small-plates kitchen. Plated service, intimate room, seasonal menu.',
      primaryColor: '#2D4A3E',
    },
    create: {
      name: 'Simmer',
      slug: 'simmer',
      type: 'restaurant',
      description: 'Fine-casual mocktail bar and small-plates kitchen. Plated service, intimate room, seasonal menu.',
      primaryColor: '#2D4A3E',
      taxRate: 17,
      isActive: true,
    },
  })

  const stax = await prisma.concept.upsert({
    where: { slug: 'stax' },
    update: {
      name: 'Stax',
      description: 'Smash burgers and loaded fries. House-made sauces, double-smash technique, delivery-first kitchen.',
      primaryColor: '#D4581A',
    },
    create: {
      name: 'Stax',
      slug: 'stax',
      type: 'digital',
      description: 'Smash burgers and loaded fries. House-made sauces, double-smash technique, delivery-first kitchen.',
      primaryColor: '#D4581A',
      taxRate: 17,
      isActive: true,
    },
  })

  const strata = await prisma.concept.upsert({
    where: { slug: 'strata' },
    update: {
      name: 'Strata',
      description: 'High-protein, clean-label cooking. Every dish ships with macros printed on the lid.',
      primaryColor: '#2D6A4F',
    },
    create: {
      name: 'Strata',
      slug: 'strata',
      type: 'digital',
      description: 'High-protein, clean-label cooking. Every dish ships with macros printed on the lid.',
      primaryColor: '#2D6A4F',
      taxRate: 17,
      isActive: true,
    },
  })

  const flipd = await prisma.concept.upsert({
    where: { slug: 'flipd' },
    update: {
      name: 'Flipd',
      description: 'Buttermilk-brined, hand-breaded crispy chicken. Every piece made to order, never reheated.',
      primaryColor: '#E5A100',
    },
    create: {
      name: 'Flipd',
      slug: 'flipd',
      type: 'digital',
      description: 'Buttermilk-brined, hand-breaded crispy chicken. Every piece made to order, never reheated.',
      primaryColor: '#E5A100',
      taxRate: 17,
      isActive: true,
    },
  })

  const padel = await prisma.concept.upsert({
    where: { slug: 'stax-padel' },
    update: {
      name: 'Stax @ Padel',
      description: 'Container-kitchen Stax at the padel court. Same smash burgers, faster fire. Order between sets.',
      primaryColor: '#DC2626',
    },
    create: {
      name: 'Stax @ Padel',
      slug: 'stax-padel',
      type: 'cart',
      description: 'Container-kitchen Stax at the padel court. Same smash burgers, faster fire. Order between sets.',
      primaryColor: '#DC2626',
      taxRate: 17,
      isActive: true,
    },
  })

  const bukhari = await prisma.concept.upsert({
    where: { slug: 'bukhari' },
    update: {
      name: 'Bukhari',
      description: 'Heritage Pakistani. Saffron rice, lamb on the bone, three-generation recipes. Since 1953.',
      primaryColor: '#7a1f24',
    },
    create: {
      name: 'Bukhari',
      slug: 'bukhari',
      type: 'restaurant',
      description: 'Heritage Pakistani. Saffron rice, lamb on the bone, three-generation recipes. Since 1953.',
      primaryColor: '#7a1f24',
      taxRate: 17,
      isActive: true,
    },
  })

  const craveman = await prisma.concept.upsert({
    where: { slug: 'craveman' },
    update: {
      name: 'Craveman',
      description: 'Karachi desi comfort food. Karahi bowls, seekh wraps, rice plates. Ghost kitchen, delivery-first.',
      primaryColor: '#F5A623',
    },
    create: {
      name: 'Craveman',
      slug: 'craveman',
      type: 'digital',
      description: 'Karachi desi comfort food. Karahi bowls, seekh wraps, rice plates. Ghost kitchen, delivery-first.',
      primaryColor: '#F5A623',
      taxRate: 17,
      isActive: true,
    },
  })

  const garnishStation = await prisma.concept.upsert({
    where: { slug: 'garnish-station' },
    update: {
      name: 'Garnish Station',
      description: 'Build-your-own bowls and wraps from an outdoor walk-up cart.',
      primaryColor: '#C4A24A',
    },
    create: {
      name: 'Garnish Station',
      slug: 'garnish-station',
      type: 'cart',
      description: 'Build-your-own bowls and wraps from an outdoor walk-up cart.',
      primaryColor: '#C4A24A',
      taxRate: 17,
      isActive: true,
    },
  })

  console.info('✓ Concepts seeded:', [simmer, stax, strata, flipd, craveman, garnishStation, padel, bukhari].map((c) => c.name))

  // ─── Kitchen Stations ─────────────────────────────────────────────────────

  const stationDefs = [
    { name: 'Grill',     displayOrder: 0 },
    { name: 'Cold',      displayOrder: 1 },
    { name: 'Drinks',    displayOrder: 2 },
    { name: 'Cart',      displayOrder: 3 },
    { name: 'Expo / Pass', displayOrder: 4 },
  ]

  for (const concept of [simmer, stax, strata, flipd, craveman, garnishStation, padel, bukhari]) {
    for (const def of stationDefs) {
      await prisma.station.upsert({
        where: { id: `${concept.slug}-${def.name.toLowerCase().replace(/\s+/g, '-')}` },
        update: {},
        create: {
          id: `${concept.slug}-${def.name.toLowerCase().replace(/\s+/g, '-')}`,
          conceptId: concept.id,
          name: def.name,
          displayOrder: def.displayOrder,
          isActive: true,
        },
      })
    }
  }

  console.info('✓ Kitchen stations seeded')

  // ─── Chart of Accounts (FBR-aligned PKR ledger) ──────────────────────────
  //
  // Numbering convention:
  //   1xxx assets · 2xxx liabilities · 3xxx equity · 4xxx revenue
  //   5xxx COGS · 6xxx operating expenses · 7xxx contra-revenue
  //   8xxx other (variances, FX)

  const accounts: Array<{ code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'; description?: string }> = [
    // ── Assets ────────────────────────────────────────────────────────────
    { code: '1010', name: 'Cash on Hand',                       type: 'asset',     description: 'Petty cash / safe' },
    { code: '1015', name: 'Cash in POS Drawer',                 type: 'asset',     description: 'Open-shift drawer floats and takings before deposit' },
    { code: '1020', name: 'Bank — Operating Account',           type: 'asset' },
    { code: '1030', name: 'Card / Gateway Receivable',          type: 'asset',     description: 'Keenu / JazzCash / Easypaisa awaiting settlement' },
    { code: '1110', name: 'Customer Accounts Receivable',       type: 'asset' },
    { code: '1120', name: 'Foodpanda Settlement Receivable',    type: 'asset',     description: 'Net of commission, due from Foodpanda' },
    { code: '1210', name: 'Inventory — Food',                   type: 'asset' },
    { code: '1220', name: 'Inventory — Beverage',               type: 'asset' },
    { code: '1230', name: 'Inventory — Packaging',              type: 'asset' },
    { code: '1310', name: 'Prepaid Expenses',                   type: 'asset' },
    { code: '1320', name: 'GST Input (Recoverable)',            type: 'asset',     description: 'Federal sales tax (FBR) recoverable on supplier purchases — offsets 2030' },
    { code: '1321', name: 'PRA Sales Tax Input',                type: 'asset',     description: 'Punjab Revenue Authority sales tax on services — recoverable, Punjab outlets only' },
    { code: '1322', name: 'SRB Sales Tax Input',                type: 'asset',     description: 'Sindh Revenue Board sales tax — Sindh outlets only' },
    { code: '1323', name: 'KPRA Sales Tax Input',               type: 'asset',     description: 'KP Revenue Authority sales tax — KP outlets only' },
    { code: '1324', name: 'BRA Sales Tax Input',                type: 'asset',     description: 'Balochistan Revenue Authority sales tax — Balochistan outlets only' },
    { code: '1330', name: 'Income Tax (WHT) Receivable',        type: 'asset',     description: 'Income tax withheld at source by clients/platforms' },
    { code: '1340', name: 'Advances to Suppliers',              type: 'asset',     description: 'Payments made before goods received' },
    { code: '1510', name: 'Kitchen Equipment',                  type: 'asset' },
    { code: '1520', name: 'Furniture & Fixtures',               type: 'asset' },
    { code: '1530', name: 'IT Equipment',                       type: 'asset' },
    { code: '1590', name: 'Accumulated Depreciation',           type: 'asset',     description: 'Contra-asset' },

    // ── Liabilities ───────────────────────────────────────────────────────
    { code: '2010', name: 'Accounts Payable — Suppliers',       type: 'liability' },
    { code: '2020', name: 'Wages Payable',                      type: 'liability' },
    { code: '2030', name: 'GST Output (Payable to FBR)',        type: 'liability', description: 'Federal sales tax (17%) collected on sales — owed to FBR' },
    { code: '2031', name: 'PRA Sales Tax Output',               type: 'liability', description: 'Punjab service-sector sales tax collected' },
    { code: '2032', name: 'SRB Sales Tax Output',               type: 'liability', description: 'Sindh service-sector sales tax' },
    { code: '2033', name: 'KPRA Sales Tax Output',              type: 'liability', description: 'KP service-sector sales tax' },
    { code: '2034', name: 'BRA Sales Tax Output',               type: 'liability', description: 'Balochistan service-sector sales tax' },
    { code: '2040', name: 'Income Tax Withholding Payable',     type: 'liability', description: 'WHT deducted from supplier payments — owed to FBR' },
    { code: '2041', name: 'Sales Tax Withholding Payable',      type: 'liability', description: 'STWH where we are the withholding agent' },
    { code: '2050', name: 'Customer Wallet Liability',          type: 'liability', description: 'Funds customers have loaded but not spent' },
    { code: '2060', name: 'Loyalty Points Liability',           type: 'liability', description: 'Accrued unredeemed loyalty points (breakage)' },
    { code: '2070', name: 'Foodpanda Commission Payable',       type: 'liability' },
    { code: '2080', name: 'Gift Card Liability',                type: 'liability' },
    { code: '2090', name: 'Accrued Expenses',                   type: 'liability' },
    { code: '2095', name: 'Tips Payable to Staff',              type: 'liability', description: 'Customer-discretionary tips received, owed to staff' },

    // ── Equity ────────────────────────────────────────────────────────────
    { code: '3010', name: "Owner's Capital",                    type: 'equity' },
    { code: '3020', name: 'Retained Earnings',                  type: 'equity' },
    { code: '3030', name: "Owner's Drawings",                   type: 'equity' },

    // ── Revenue (per concept) ────────────────────────────────────────────
    { code: '4001', name: 'Revenue — Simmer',                   type: 'revenue' },
    { code: '4002', name: 'Revenue — Stax',                     type: 'revenue' },
    { code: '4003', name: 'Revenue — Strata',                   type: 'revenue' },
    { code: '4004', name: 'Revenue — Flipd',                    type: 'revenue' },
    { code: '4005', name: 'Revenue — Garnish Station',          type: 'revenue' },
    { code: '4006', name: 'Revenue — Stax @ Padel',             type: 'revenue' },
    { code: '4007', name: 'Revenue — Bukhari',                  type: 'revenue' },
    { code: '4090', name: 'Revenue — Other / Catering',         type: 'revenue' },
    { code: '4100', name: 'Service Charges',                    type: 'revenue' },

    // ── COGS ──────────────────────────────────────────────────────────────
    { code: '5010', name: 'Food Cost',                          type: 'expense' },
    { code: '5020', name: 'Beverage Cost',                      type: 'expense' },
    { code: '5030', name: 'Packaging Cost',                     type: 'expense' },
    { code: '5040', name: 'Waste / Spoilage',                   type: 'expense' },
    { code: '5050', name: 'Inventory Variance',                 type: 'expense' },
    { code: '5060', name: 'Inventory Cost Adjustment',          type: 'expense' },

    // ── Operating expenses ────────────────────────────────────────────────
    { code: '6010', name: 'Rent',                               type: 'expense' },
    { code: '6020', name: 'Electricity',                        type: 'expense' },
    { code: '6021', name: 'Gas',                                type: 'expense' },
    { code: '6022', name: 'Internet & Telecom',                 type: 'expense' },
    { code: '6023', name: 'Water',                              type: 'expense' },
    { code: '6030', name: 'Wages — Kitchen',                    type: 'expense' },
    { code: '6031', name: 'Wages — Front of House',             type: 'expense' },
    { code: '6032', name: 'Wages — Management',                 type: 'expense' },
    { code: '6035', name: 'Wages — Riders / Delivery',          type: 'expense' },
    { code: '6040', name: 'Cleaning & Supplies',                type: 'expense' },
    { code: '6050', name: 'Repairs & Maintenance',              type: 'expense' },
    { code: '6060', name: 'Marketing & Promo',                  type: 'expense' },
    { code: '6070', name: 'Software & Subscriptions',           type: 'expense' },
    { code: '6080', name: 'Bank / Card Processing Fees',        type: 'expense' },
    { code: '6081', name: 'Bank Charges (Misc)',                type: 'expense' },
    { code: '6090', name: 'Foodpanda Commission Expense',       type: 'expense' },
    { code: '6095', name: 'Aggregator Commission (Other)',      type: 'expense' },
    { code: '6100', name: 'Insurance',                          type: 'expense' },
    { code: '6110', name: 'Professional Fees (Legal/Accounting)', type: 'expense' },
    { code: '6120', name: 'Licences & Permits',                 type: 'expense' },
    { code: '6130', name: 'Property Taxes',                     type: 'expense' },
    { code: '6140', name: 'Travel & Entertainment',             type: 'expense' },
    { code: '6150', name: 'Depreciation Expense',               type: 'expense' },

    // ── Contra-revenue ────────────────────────────────────────────────────
    { code: '7010', name: 'Discounts Given',                    type: 'expense' },
    { code: '7020', name: 'Loyalty Redemptions',                type: 'expense' },
    { code: '7030', name: 'Comps & Promo Items',                type: 'expense' },
    { code: '7040', name: 'Refunds Issued',                     type: 'expense' },

    // ── Other ─────────────────────────────────────────────────────────────
    { code: '8010', name: 'Cash Variance (Over / Short)',       type: 'expense' },
    { code: '8020', name: 'Foreign Exchange Gain / Loss',       type: 'expense' },
  ]

  // Each company keeps its OWN chart of accounts (Account.tenantId; the code
  // is unique per company), so seed the full chart for every company.
  const seedTenants = await prisma.tenant.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, slug: true },
  })
  for (const t of seedTenants) {
    for (const acc of accounts) {
      await prisma.account.upsert({
        where: { tenantId_code: { tenantId: t.id, code: acc.code } },
        update: { name: acc.name, type: acc.type, description: acc.description ?? null, isActive: true },
        create: { ...acc, tenantId: t.id, isActive: true },
      })
    }
  }

  await prisma.account.updateMany({
    where: { name: 'Craveman Revenue' },
    data: { isActive: false },
  })

  console.info(`✓ Chart of accounts seeded (${accounts.length} accounts × ${seedTenants.length} company(ies))`)

  // ─── Admin user ────────────────────────────────────────────────────────────

  const seedAdminEmail    = process.env['SEED_ADMIN_EMAIL']
  const seedAdminPassword = process.env['SEED_ADMIN_PASSWORD']
  const seedAdminPin      = process.env['SEED_ADMIN_PIN']

  if (seedAdminEmail && seedAdminPassword) {
    if (seedAdminPassword.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters')
    if (seedAdminPin && !/^\d{4,8}$/.test(seedAdminPin)) throw new Error('SEED_ADMIN_PIN must be 4–8 digits')

    const adminPassword = await bcrypt.hash(seedAdminPassword, 12)
    const adminPin = seedAdminPin ? await bcrypt.hash(seedAdminPin, 10) : null

    await prisma.user.upsert({
      where: { email: seedAdminEmail.toLowerCase() },
      update: {},
      create: {
        name: 'Admin',
        email: seedAdminEmail.toLowerCase(),
        password: adminPassword,
        pin: adminPin,
        role: 'admin',
        isActive: true,
      },
    })
    console.info(`✓ Admin user seeded (email: ${seedAdminEmail})`)
  } else {
    console.info('• Admin user NOT seeded — set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one')
  }

  // ─── SIMMER menu ──────────────────────────────────────────────────────────
  // Fine-casual mocktail bar. Check avg ~Rs. 2,500–3,000 per cover.
  // Service: Dinner 7:00PM–10:30PM · Late Night 10:30PM–2:30AM

  const simmerMocktailsCat = await prisma.category.upsert({
    where: { id: 'simmer-mocktails' }, update: { sortOrder: 0 },
    create: { id: 'simmer-mocktails', conceptId: simmer.id, name: 'Mocktails', sortOrder: 0 },
  })
  const simmerSmallPlatesCat = await prisma.category.upsert({
    where: { id: 'simmer-small-plates' }, update: { sortOrder: 1 },
    create: { id: 'simmer-small-plates', conceptId: simmer.id, name: 'Small Plates', sortOrder: 1 },
  })
  const simmerMainsCat = await prisma.category.upsert({
    where: { id: 'simmer-mains' }, update: { sortOrder: 2 },
    create: { id: 'simmer-mains', conceptId: simmer.id, name: 'Mains', sortOrder: 2 },
  })
  const simmerDessertsCat = await prisma.category.upsert({
    where: { id: 'simmer-desserts' }, update: { sortOrder: 3 },
    create: { id: 'simmer-desserts', conceptId: simmer.id, name: 'Desserts', sortOrder: 3 },
  })

  const simmerItems = [
    // Mocktails
    { id: 'simmer-item-001', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'The Garden Fizz',       price: 75000,  desc: 'Cucumber, elderflower, mint, sparkling water, citrus.' },
    { id: 'simmer-item-002', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Midnight Bloom',        price: 78000,  desc: 'Butterfly pea flower, lemon, honey, tonic.' },
    { id: 'simmer-item-003', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Stone Rose',            price: 80000,  desc: 'Rose water, lychee, ginger, lime, soda.' },
    { id: 'simmer-item-004', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Morning After',         price: 75000,  desc: 'Cold-pressed ginger, turmeric, lemon, honey, sparkling.' },
    { id: 'simmer-item-005', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Simmer Signature',      price: 85000,  desc: 'House blend, seasonal fruit, soda. Ask the bar.' },
    { id: 'simmer-item-006', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Sparkling Lemonade',    price: 55000,  desc: 'Fresh lemon, mint, sparkling water.' },
    { id: 'simmer-item-007', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Berry Bliss',           price: 65000,  desc: 'Mixed berries, basil, lime, soda.' },
    { id: 'simmer-item-008', cat: simmerMocktailsCat.id, station: 'simmer-drinks', name: 'Watermelon Cooler',     price: 60000,  desc: 'Fresh watermelon, ginger, lemon, mint.' },
    // Small plates
    { id: 'simmer-item-010', cat: simmerSmallPlatesCat.id, station: 'simmer-cold', name: 'Smoked Labneh',         price: 90000,  desc: 'Wood-smoked labneh, za\'atar oil, warm pita, olives.' },
    { id: 'simmer-item-011', cat: simmerSmallPlatesCat.id, station: 'simmer-cold', name: 'Bruschetta Board',      price: 95000,  desc: 'Sourdough, heirloom tomatoes, basil oil, flaked salt.' },
    { id: 'simmer-item-012', cat: simmerSmallPlatesCat.id, station: 'simmer-grill', name: 'Crispy Calamari',      price: 115000, desc: 'Lemon aioli, chilli flakes, parsley.' },
    { id: 'simmer-item-013', cat: simmerSmallPlatesCat.id, station: 'simmer-cold', name: 'Burrata & Peach',       price: 130000, desc: 'Stracciatella, prosciutto, balsamic, basil.' },
    { id: 'simmer-item-014', cat: simmerSmallPlatesCat.id, station: 'simmer-grill', name: 'Truffle Fries',        price: 85000,  desc: 'Hand-cut, truffle oil, parmesan, herbs.' },
    { id: 'simmer-item-015', cat: simmerSmallPlatesCat.id, station: 'simmer-cold', name: 'Artichoke & Spinach',   price: 110000, desc: 'Warm dip, toasted flatbread, roasted garlic.' },
    { id: 'simmer-item-016', cat: simmerSmallPlatesCat.id, station: 'simmer-grill', name: 'Chicken Skewers',      price: 120000, desc: 'Charred thigh skewers, harissa yoghurt, pomegranate.' },
    // Mains
    { id: 'simmer-item-020', cat: simmerMainsCat.id, station: 'simmer-grill', name: 'Slow-Roast Lamb Shoulder',   price: 195000, desc: 'Twelve-hour lamb, pomegranate jus, roasted root veg.' },
    { id: 'simmer-item-021', cat: simmerMainsCat.id, station: 'simmer-grill', name: 'Pan-Seared Salmon',          price: 175000, desc: 'Lemon caper butter, wilted greens, potato gratin.' },
    { id: 'simmer-item-022', cat: simmerMainsCat.id, station: 'simmer-grill', name: 'Mushroom Risotto',           price: 150000, desc: 'Arborio, wild mushrooms, truffle, parmesan. Vegetarian.' },
    { id: 'simmer-item-023', cat: simmerMainsCat.id, station: 'simmer-grill', name: 'Grilled Beef Tenderloin',    price: 220000, desc: 'Chimichurri, roasted garlic mash, haricot verts.' },
    // Desserts
    { id: 'simmer-item-030', cat: simmerDessertsCat.id, station: 'simmer-cold', name: 'Dark Chocolate Fondant',   price: 80000,  desc: 'Molten centre, vanilla bean ice cream, caramel tuile.' },
    { id: 'simmer-item-031', cat: simmerDessertsCat.id, station: 'simmer-cold', name: 'Pistachio Panna Cotta',    price: 75000,  desc: 'Rose-water syrup, crushed pistachios.' },
    { id: 'simmer-item-032', cat: simmerDessertsCat.id, station: 'simmer-cold', name: 'Cheese Board',             price: 140000, desc: 'Three local artisan cheeses, honey, walnut, crackers.' },
  ]

  for (const [i, item] of simmerItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: simmer.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Simmer menu seeded')

  // ─── STAX menu ────────────────────────────────────────────────────────────
  // Smash burgers. Check avg ~Rs. 1,200–1,600. Ghost kitchen, delivery-first.
  // Service: Lunch 12:00–3:00 · Dinner 7:00–11:00

  const staxBurgersCat = await prisma.category.upsert({
    where: { id: 'stax-burgers' }, update: { sortOrder: 0 },
    create: { id: 'stax-burgers', conceptId: stax.id, name: 'Burgers', sortOrder: 0 },
  })
  const staxFriesCat = await prisma.category.upsert({
    where: { id: 'stax-fries' }, update: { sortOrder: 1 },
    create: { id: 'stax-fries', conceptId: stax.id, name: 'Loaded Fries', sortOrder: 1 },
  })
  const staxSidesCat = await prisma.category.upsert({
    where: { id: 'stax-sides' }, update: { sortOrder: 2 },
    create: { id: 'stax-sides', conceptId: stax.id, name: 'Sides & Sauces', sortOrder: 2 },
  })
  const staxDrinksCat = await prisma.category.upsert({
    where: { id: 'stax-drinks' }, update: { sortOrder: 3 },
    create: { id: 'stax-drinks', conceptId: stax.id, name: 'Drinks', sortOrder: 3 },
  })

  // Keep IDs stable — stax-item-001..008 were previously used, continue from there
  const staxItems = [
    // Burgers
    { id: 'stax-item-001', cat: staxBurgersCat.id,  station: 'stax-grill', name: 'The Stax Classic',          price: 120000, desc: 'Double smash patty, aged cheddar, pickles, special sauce, brioche.' },
    { id: 'stax-item-002', cat: staxBurgersCat.id,  station: 'stax-grill', name: 'Crispy Chicken Sandwich',   price: 115000, desc: 'Fried thigh, slaw, chipotle mayo, potato bun.' },
    { id: 'stax-item-003', cat: staxBurgersCat.id,  station: 'stax-grill', name: 'Mushroom Swiss Melt',       price: 110000, desc: 'Sautéed mushrooms, swiss, caramelised onion, smash patty.' },
    { id: 'stax-item-004', cat: staxBurgersCat.id,  station: 'stax-grill', name: 'Spicy Stax',                price: 125000, desc: 'Double smash, ghost-pepper mayo, jalapeños, pickles.' },
    { id: 'stax-item-005', cat: staxBurgersCat.id,  station: 'stax-grill', name: 'BBQ Bacon Stack',           price: 130000, desc: 'Smash patty, beef bacon, BBQ glaze, onion rings, cheddar.' },
    // Loaded fries
    { id: 'stax-item-006', cat: staxFriesCat.id,    station: 'stax-cold',  name: 'Original Stax Fries',       price: 75000,  desc: 'Seasoned fries, cheese sauce, jalapeños, spring onion.' },
    { id: 'stax-item-007', cat: staxFriesCat.id,    station: 'stax-cold',  name: 'Pulled Chicken Fries',      price: 90000,  desc: 'Shredded chicken, BBQ glaze, pickled onions, ranch.' },
    { id: 'stax-item-008', cat: staxFriesCat.id,    station: 'stax-cold',  name: 'Truffle Parmesan Fries',    price: 95000,  desc: 'Truffle oil, parmesan, chives, truffle mayo.' },
    { id: 'stax-item-009', cat: staxFriesCat.id,    station: 'stax-cold',  name: 'Nacho Cheese Fries',        price: 80000,  desc: 'Cheddar nacho sauce, pickled jalapeños, sour cream.' },
    // Sides
    { id: 'stax-item-010', cat: staxSidesCat.id,    station: 'stax-grill', name: 'Onion Rings (6 pc)',        price: 50000,  desc: 'Buttermilk-battered, seasoned salt.' },
    { id: 'stax-item-011', cat: staxSidesCat.id,    station: 'stax-cold',  name: 'House Slaw',                price: 35000,  desc: 'Cabbage, carrot, apple cider vinegar dressing.' },
    { id: 'stax-item-012', cat: staxSidesCat.id,    station: 'stax-cold',  name: 'Extra Special Sauce',       price: 20000,  desc: 'House-made. It\'s the sauce. 60ml.' },
    // Drinks
    { id: 'stax-item-013', cat: staxDrinksCat.id,   station: 'stax-drinks', name: 'Classic Cola',             price: 20000,  desc: '330ml can.' },
    { id: 'stax-item-014', cat: staxDrinksCat.id,   station: 'stax-drinks', name: 'Iced Lemonade',            price: 35000,  desc: 'House-made, fresh lemon, light sugar.' },
    { id: 'stax-item-015', cat: staxDrinksCat.id,   station: 'stax-drinks', name: 'Mango Lemonade',           price: 40000,  desc: 'Alphonso mango, fresh lemon, sparkling.' },
    { id: 'stax-item-016', cat: staxDrinksCat.id,   station: 'stax-drinks', name: 'Mineral Water',            price: 10000,  desc: '500ml.' },
  ]

  for (const [i, item] of staxItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: stax.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Stax menu seeded')

  // ─── STRATA menu ──────────────────────────────────────────────────────────
  // High-protein. Check avg ~Rs. 1,000–1,400. Macros on everything.
  // Service: Lunch 12:00–3:00 · Dinner 7:00–10:30

  const strataBowlsCat = await prisma.category.upsert({
    where: { id: 'strata-bowls' }, update: { sortOrder: 0 },
    create: { id: 'strata-bowls', conceptId: strata.id, name: 'Protein Bowls', sortOrder: 0 },
  })
  const strataWrapsCat = await prisma.category.upsert({
    where: { id: 'strata-wraps' }, update: { sortOrder: 1 },
    create: { id: 'strata-wraps', conceptId: strata.id, name: 'Wraps', sortOrder: 1 },
  })
  const strataAddOnsCat = await prisma.category.upsert({
    where: { id: 'strata-addons' }, update: { sortOrder: 2 },
    create: { id: 'strata-addons', conceptId: strata.id, name: 'Add-ons', sortOrder: 2 },
  })
  const strataDrinksCat = await prisma.category.upsert({
    where: { id: 'strata-drinks' }, update: { sortOrder: 3 },
    create: { id: 'strata-drinks', conceptId: strata.id, name: 'Drinks & Shakes', sortOrder: 3 },
  })

  const strataItems = [
    // Bowls — prices & macro goals directly from brand layout
    { id: 'strata-item-001', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Performance Bowl',        price: 110000, desc: 'Quinoa, grilled chicken, roasted veg, tahini. 45P · 58C · 14F · 600kcal.' },
    { id: 'strata-item-002', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Protein Stack Bowl',      price: 125000, desc: 'Lean beef, sweet potato, avocado, brown rice. 52P · 64C · 18F · 700kcal.' },
    { id: 'strata-item-003', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Rebuild Bowl',            price: 130000, desc: 'Post-lift macros. No compromises. 58P · 72C · 20F · 760kcal.' },
    { id: 'strata-item-004', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Cut-Day Bowl',            price: 95000,  desc: 'Sub-400 kcal, 42g protein, real food. 42P · 22C · 9F · 380kcal.' },
    { id: 'strata-item-005', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Endurance Plate',         price: 115000, desc: 'Carb-heavy for cardio days. Chicken thigh, jasmine rice, slaw. 36P · 80C · 12F · 620kcal.' },
    { id: 'strata-item-006', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Falafel & Hummus Bowl',   price: 95000,  desc: 'Herbed falafel, hummus, tabbouleh, pita chips. Vegetarian. 28P · 52C · 16F · 510kcal.' },
    { id: 'strata-item-007', cat: strataBowlsCat.id,  station: 'strata-grill', name: 'Beef Steak Bowl',         price: 135000, desc: 'Quinoa, seared beef strips, chimichurri, pickled cabbage. 48P · 45C · 20F · 640kcal.' },
    // Wraps
    { id: 'strata-item-008', cat: strataWrapsCat.id,  station: 'strata-grill', name: 'Power Wrap',             price: 85000,  desc: 'Egg whites, spinach, hummus, whole-wheat wrap. 38P · 32C · 11F · 460kcal.' },
    { id: 'strata-item-009', cat: strataWrapsCat.id,  station: 'strata-grill', name: 'High-Protein Wrap',      price: 100000, desc: 'Chicken breast, egg white, greens, avocado, whole wheat tortilla. 44P · 36C · 13F · 500kcal.' },
    { id: 'strata-item-010', cat: strataWrapsCat.id,  station: 'strata-grill', name: 'Shawarma Wrap',          price: 110000, desc: 'Spiced chicken, garlic sauce, pickles, whole wheat tortilla. 38P · 48C · 14F · 530kcal.' },
    // Add-ons
    { id: 'strata-item-011', cat: strataAddOnsCat.id, station: 'strata-cold',  name: 'Extra Protein (+60g)',   price: 35000,  desc: 'Add grilled chicken breast to any bowl or wrap.' },
    { id: 'strata-item-012', cat: strataAddOnsCat.id, station: 'strata-cold',  name: 'Avocado (+)',            price: 30000,  desc: 'Half avocado, sliced.' },
    { id: 'strata-item-013', cat: strataAddOnsCat.id, station: 'strata-cold',  name: 'Brown Rice Side',        price: 25000,  desc: 'Plain steamed brown rice, 150g.' },
    // Drinks
    { id: 'strata-item-014', cat: strataDrinksCat.id, station: 'strata-drinks', name: 'Protein Shake',         price: 45000,  desc: 'Whey, banana, almond milk — 30g protein, 280kcal.' },
    { id: 'strata-item-015', cat: strataDrinksCat.id, station: 'strata-drinks', name: 'Green Detox Juice',     price: 40000,  desc: 'Spinach, cucumber, apple, ginger, lemon.' },
    { id: 'strata-item-016', cat: strataDrinksCat.id, station: 'strata-drinks', name: 'Electrolyte Water',     price: 20000,  desc: '500ml electrolyte-enhanced still water.' },
  ]

  for (const [i, item] of strataItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: strata.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Strata menu seeded')

  // ─── FLIPD menu ───────────────────────────────────────────────────────────
  // Buttermilk crispy chicken. Check avg ~Rs. 1,000–1,200. Ghost kitchen.
  // Service: Lunch 12:00–3:00 · Dinner 7:00–11:00

  const flipdSinglesCat = await prisma.category.upsert({
    where: { id: 'flipd-singles' }, update: { sortOrder: 0 },
    create: { id: 'flipd-singles', conceptId: flipd.id, name: 'Sandwiches & Tenders', sortOrder: 0 },
  })
  const flipdBucketsCat = await prisma.category.upsert({
    where: { id: 'flipd-buckets' }, update: { sortOrder: 1 },
    create: { id: 'flipd-buckets', conceptId: flipd.id, name: 'Buckets', sortOrder: 1 },
  })
  const flipdSidesCat = await prisma.category.upsert({
    where: { id: 'flipd-sides' }, update: { sortOrder: 2 },
    create: { id: 'flipd-sides', conceptId: flipd.id, name: 'Sides & Sauces', sortOrder: 2 },
  })
  const flipdDrinksCat = await prisma.category.upsert({
    where: { id: 'flipd-drinks' }, update: { sortOrder: 3 },
    create: { id: 'flipd-drinks', conceptId: flipd.id, name: 'Drinks', sortOrder: 3 },
  })

  const flipdItems = [
    // Singles — prices from brand layout
    { id: 'flipd-item-001', cat: flipdSinglesCat.id, station: 'flipd-grill', name: 'Classic Crispy Sandwich',  price: 89000,  desc: 'Buttermilk-brined breast, pickles, brioche, Flipd sauce.' },
    { id: 'flipd-item-002', cat: flipdSinglesCat.id, station: 'flipd-grill', name: 'Hot Honey Tenders (4 pc)', price: 95000,  desc: 'Hand-breaded tenders, hot honey drizzle, ranch.' },
    { id: 'flipd-item-003', cat: flipdSinglesCat.id, station: 'flipd-grill', name: 'Smoked Maple Sandwich',    price: 99000,  desc: 'Cherry-wood smoke, maple glaze, jalapeño slaw, brioche.' },
    { id: 'flipd-item-004', cat: flipdSinglesCat.id, station: 'flipd-grill', name: 'Spicy Crispy Sandwich',    price: 92000,  desc: 'Ghost-pepper-honey brine, pickles, slaw, mayo.' },
    { id: 'flipd-item-005', cat: flipdSinglesCat.id, station: 'flipd-grill', name: 'Tenders (8 pc)',           price: 175000, desc: 'Eight hand-breaded tenders. Choice of sauce.' },
    // Loaded fries
    { id: 'flipd-item-006', cat: flipdSidesCat.id,   station: 'flipd-cold',  name: 'Loaded Chicken Fries',    price: 105000, desc: 'Fries, cheese sauce, jalapeño, tender pieces, ranch.' },
    // Buckets — prices from brand layout
    { id: 'flipd-item-010', cat: flipdBucketsCat.id, station: 'flipd-grill', name: 'The Lunch Bucket',        price: 120000, desc: 'Sandwich + fries + drink. Solo deal.' },
    { id: 'flipd-item-011', cat: flipdBucketsCat.id, station: 'flipd-grill', name: 'The Squad Bucket',        price: 345000, desc: '3 sandwiches · 8 tenders · 2 large fries · 4 sauces. Feeds 3.' },
    { id: 'flipd-item-012', cat: flipdBucketsCat.id, station: 'flipd-grill', name: 'The Family Coop',         price: 580000, desc: '5 sandwiches · 16 tenders · large fries · slaw · 6 sauces. Feeds 5.' },
    { id: 'flipd-item-013', cat: flipdBucketsCat.id, station: 'flipd-grill', name: 'The Tender Trove',        price: 450000, desc: '20 tenders · 4 sauces · 2 large fries · pickles. Feeds 4.' },
    // Sides
    { id: 'flipd-item-020', cat: flipdSidesCat.id,   station: 'flipd-cold',  name: 'Regular Fries',           price: 35000,  desc: 'Seasoned, sea salt.' },
    { id: 'flipd-item-021', cat: flipdSidesCat.id,   station: 'flipd-cold',  name: 'Large Fries',             price: 50000,  desc: 'Big bag, seasoned.' },
    { id: 'flipd-item-022', cat: flipdSidesCat.id,   station: 'flipd-cold',  name: 'Pickles (side)',          price: 15000,  desc: 'House-brined dill pickles.' },
    { id: 'flipd-item-023', cat: flipdSidesCat.id,   station: 'flipd-cold',  name: 'Sauce (60ml)',            price: 15000,  desc: 'Flipd sauce / ranch / hot honey / BBQ.' },
    // Drinks
    { id: 'flipd-item-030', cat: flipdDrinksCat.id,  station: 'flipd-drinks', name: 'Classic Cola',           price: 20000,  desc: '330ml can.' },
    { id: 'flipd-item-031', cat: flipdDrinksCat.id,  station: 'flipd-drinks', name: 'Iced Lemonade',          price: 35000,  desc: 'Fresh lemon, light sugar.' },
    { id: 'flipd-item-032', cat: flipdDrinksCat.id,  station: 'flipd-drinks', name: 'Mineral Water',          price: 10000,  desc: '500ml.' },
  ]

  for (const [i, item] of flipdItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: flipd.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Flipd menu seeded')

  // ─── BUKHARI menu ─────────────────────────────────────────────────────────
  // Heritage Pakistani. Check avg Rs. 1,500–2,000 individual / Rs. 3,000+ family.
  // Service: Lunch 12:00–3:00 · Dinner 7:00–11:00 · Catering by request

  const bukhariFeaturedCat = await prisma.category.upsert({
    where: { id: 'bukhari-featured' }, update: { sortOrder: 0 },
    create: { id: 'bukhari-featured', conceptId: bukhari.id, name: 'Bukhari Rice', sortOrder: 0 },
  })
  const bukhariPlatsCat = await prisma.category.upsert({
    where: { id: 'bukhari-platters' }, update: { sortOrder: 1 },
    create: { id: 'bukhari-platters', conceptId: bukhari.id, name: 'Family Platters', sortOrder: 1 },
  })
  const bukhariSidesCat = await prisma.category.upsert({
    where: { id: 'bukhari-sides' }, update: { sortOrder: 2 },
    create: { id: 'bukhari-sides', conceptId: bukhari.id, name: 'Sides', sortOrder: 2 },
  })
  const bukhariDessertsCat = await prisma.category.upsert({
    where: { id: 'bukhari-desserts' }, update: { sortOrder: 3 },
    create: { id: 'bukhari-desserts', conceptId: bukhari.id, name: 'Desserts', sortOrder: 3 },
  })
  const bukhariDrinksCat = await prisma.category.upsert({
    where: { id: 'bukhari-drinks' }, update: { sortOrder: 4 },
    create: { id: 'bukhari-drinks', conceptId: bukhari.id, name: 'Drinks', sortOrder: 4 },
  })
  const bukhariCateringCat = await prisma.category.upsert({
    where: { id: 'bukhari-catering' }, update: { sortOrder: 5 },
    create: { id: 'bukhari-catering', conceptId: bukhari.id, name: 'Catering (24h notice)', sortOrder: 5 },
  })

  const bukhariItems = [
    // Bukhari rice (signature)
    { id: 'bukhari-item-001', cat: bukhariFeaturedCat.id, station: 'bukhari-grill', name: 'Chicken Bukhari Rice',      price: 125000, desc: 'Slow-cooked chicken, fragrant saffron rice, raita, salad. Serves 1–2.' },
    { id: 'bukhari-item-002', cat: bukhariFeaturedCat.id, station: 'bukhari-grill', name: 'Lamb Bukhari Rice',         price: 165000, desc: 'Lamb on the bone, saffron rice, raita, salad. Slow-cooked over coals. Serves 2.' },
    { id: 'bukhari-item-003', cat: bukhariFeaturedCat.id, station: 'bukhari-grill', name: 'Prawn Bukhari Rice',        price: 185000, desc: 'Tiger prawns, saffron rice, herb raita, salad. Serves 1–2.' },
    // Family platters — prices from brand layout
    { id: 'bukhari-item-010', cat: bukhariFeaturedCat.id, station: 'bukhari-grill', name: 'Mixed Bukhari (Half)',      price: 145000, desc: 'Half chicken + half lamb rice. Perfect for two.' },
    { id: 'bukhari-item-011', cat: bukhariPlatsCat.id,    station: 'bukhari-grill', name: 'Family Platter',           price: 325000, desc: 'Lamb · chicken · rice · sides · raita · kheer. Feeds 4.' },
    { id: 'bukhari-item-012', cat: bukhariPlatsCat.id,    station: 'bukhari-grill', name: 'Extended Family Platter',  price: 480000, desc: 'Whole lamb · chicken · extra rice · 4 sides · raita · kheer · dessert. Feeds 6.' },
    // Sides
    { id: 'bukhari-item-020', cat: bukhariSidesCat.id,    station: 'bukhari-cold',  name: 'Raita',                   price: 20000,  desc: 'House-made, cucumber, cumin.' },
    { id: 'bukhari-item-021', cat: bukhariSidesCat.id,    station: 'bukhari-cold',  name: 'Fattoush Salad',          price: 35000,  desc: 'Tomato, cucumber, onion, crispy pita, sumac dressing.' },
    { id: 'bukhari-item-022', cat: bukhariSidesCat.id,    station: 'bukhari-grill', name: 'Extra Rice (portion)',    price: 40000,  desc: 'Saffron rice, 300g.' },
    { id: 'bukhari-item-023', cat: bukhariSidesCat.id,    station: 'bukhari-grill', name: 'Seekh Kebab (2 pc)',      price: 55000,  desc: 'Charcoal-grilled minced lamb seekh, green chutney.' },
    { id: 'bukhari-item-024', cat: bukhariSidesCat.id,    station: 'bukhari-grill', name: 'Shami Kebab (4 pc)',      price: 65000,  desc: 'Slow-cooked beef shami, tamarind chutney.' },
    // Desserts
    { id: 'bukhari-item-030', cat: bukhariDessertsCat.id, station: 'bukhari-cold',  name: 'Kheer',                  price: 30000,  desc: 'Full-cream milk, basmati, cardamom, pistachios.' },
    { id: 'bukhari-item-031', cat: bukhariDessertsCat.id, station: 'bukhari-cold',  name: 'Gulab Jamun (4 pc)',     price: 35000,  desc: 'Soft, syrup-soaked, rose water.' },
    // Drinks
    { id: 'bukhari-item-040', cat: bukhariDrinksCat.id,   station: 'bukhari-drinks', name: 'Laban (Salty Lassi)',   price: 25000,  desc: 'Chilled salted buttermilk, cumin.' },
    { id: 'bukhari-item-041', cat: bukhariDrinksCat.id,   station: 'bukhari-drinks', name: 'Sweet Lassi',          price: 30000,  desc: 'Full-fat yoghurt, rosewater, pistachio.' },
    { id: 'bukhari-item-042', cat: bukhariDrinksCat.id,   station: 'bukhari-drinks', name: 'Qahwa (Arabic Tea)',   price: 30000,  desc: 'Green tea, cardamom, saffron, honey.' },
    { id: 'bukhari-item-043', cat: bukhariDrinksCat.id,   station: 'bukhari-drinks', name: 'Mineral Water',        price: 10000,  desc: '500ml.' },
    // Catering (by request, 24h notice)
    { id: 'bukhari-item-050', cat: bukhariCateringCat.id, station: 'bukhari-grill', name: 'The Wedding Tray',      price: 980000, desc: 'Whole leg of lamb · biryani rice · 6 sides · 2 desserts. 24h notice. Feeds 8–10.' },
    { id: 'bukhari-item-051', cat: bukhariCateringCat.id, station: 'bukhari-grill', name: 'Catering Tray (30+)',   price: 0,      desc: 'Contact us for event pricing. 48h notice required. Brass platters on request.' },
  ]

  for (const [i, item] of bukhariItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: bukhari.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Bukhari menu seeded')

  // ─── STAX @ PADEL menu ────────────────────────────────────────────────────
  // Satellite container kitchen. Smaller menu — burgers + fries only.
  // Walk-up, pickup-first. No delivery from this location.

  const padelBurgersCat = await prisma.category.upsert({
    where: { id: 'padel-burgers' }, update: { sortOrder: 0 },
    create: { id: 'padel-burgers', conceptId: padel.id, name: 'Burgers', sortOrder: 0 },
  })
  const padelFriesCat = await prisma.category.upsert({
    where: { id: 'padel-fries' }, update: { sortOrder: 1 },
    create: { id: 'padel-fries', conceptId: padel.id, name: 'Fries', sortOrder: 1 },
  })
  const padelDrinksCat = await prisma.category.upsert({
    where: { id: 'padel-drinks' }, update: { sortOrder: 2 },
    create: { id: 'padel-drinks', conceptId: padel.id, name: 'Drinks', sortOrder: 2 },
  })

  const padelItems = [
    { id: 'padel-item-001', cat: padelBurgersCat.id, station: 'stax-padel-grill', name: 'The Stax Classic',      price: 120000, desc: 'Double smash patty, aged cheddar, pickles, special sauce, brioche.' },
    { id: 'padel-item-002', cat: padelBurgersCat.id, station: 'stax-padel-grill', name: 'Crispy Chicken',        price: 115000, desc: 'Fried thigh, slaw, chipotle mayo, potato bun.' },
    { id: 'padel-item-003', cat: padelBurgersCat.id, station: 'stax-padel-grill', name: 'Spicy Stax',            price: 125000, desc: 'Double smash, ghost-pepper mayo, jalapeños.' },
    { id: 'padel-item-004', cat: padelBurgersCat.id, station: 'stax-padel-grill', name: 'Burger + Fries Combo',  price: 145000, desc: 'Any burger + regular fries + can. Best value.' },
    { id: 'padel-item-005', cat: padelFriesCat.id,   station: 'stax-padel-cart',  name: 'Regular Fries',         price: 35000,  desc: 'Seasoned, sea salt.' },
    { id: 'padel-item-006', cat: padelFriesCat.id,   station: 'stax-padel-cart',  name: 'Cheese Fries',          price: 55000,  desc: 'Cheese sauce, jalapeños.' },
    { id: 'padel-item-007', cat: padelDrinksCat.id,  station: 'stax-padel-drinks', name: 'Can (Assorted)',       price: 20000,  desc: 'Cola / sprite / water.' },
    { id: 'padel-item-008', cat: padelDrinksCat.id,  station: 'stax-padel-drinks', name: 'Iced Lemonade',        price: 35000,  desc: 'House-made, fresh lemon.' },
  ]

  for (const [i, item] of padelItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: padel.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Stax @ Padel menu seeded')

  // ─── CRAVEMAN menu ────────────────────────────────────────────────────────
  // Karachi desi comfort food. Check avg ~Rs. 1,100–1,400. Ghost kitchen.
  // Service: Lunch 12:00–3:00 · Dinner 7:00–11:00

  const cravemanBowlsCat = await prisma.category.upsert({
    where: { id: 'craveman-bowls' }, update: { sortOrder: 0 },
    create: { id: 'craveman-bowls', conceptId: craveman.id, name: 'Rice Bowls', sortOrder: 0 },
  })
  const cravemanWrapsCat = await prisma.category.upsert({
    where: { id: 'craveman-wraps' }, update: { sortOrder: 1 },
    create: { id: 'craveman-wraps', conceptId: craveman.id, name: 'Wraps', sortOrder: 1 },
  })
  const cravemanCombosCat = await prisma.category.upsert({
    where: { id: 'craveman-combos' }, update: { sortOrder: 2 },
    create: { id: 'craveman-combos', conceptId: craveman.id, name: 'Combos', sortOrder: 2 },
  })
  const cravemanSidesCat = await prisma.category.upsert({
    where: { id: 'craveman-sides' }, update: { sortOrder: 3 },
    create: { id: 'craveman-sides', conceptId: craveman.id, name: 'Sides & Drinks', sortOrder: 3 },
  })

  const cravemanItems = [
    // Bowls
    { id: 'craveman-item-001', cat: cravemanBowlsCat.id,  station: 'craveman-grill', name: 'Butter Chicken Bowl',    price: 120000, desc: 'Basmati rice, rich butter chicken, raita, pickled onion.' },
    { id: 'craveman-item-002', cat: cravemanBowlsCat.id,  station: 'craveman-grill', name: 'Seekh Kebab Bowl',        price: 130000, desc: 'Charred seekh, saffron rice, green chutney, naan crisps.' },
    { id: 'craveman-item-003', cat: cravemanBowlsCat.id,  station: 'craveman-grill', name: 'Daal Chawal Bowl',        price: 85000,  desc: 'Masoor dal, basmati, tarka, achaar. The comfort classic.' },
    { id: 'craveman-item-004', cat: cravemanBowlsCat.id,  station: 'craveman-grill', name: 'Nihari Bowl',             price: 145000, desc: 'Slow-cooked beef nihari, naan crisp, fried ginger, green chilli.' },
    { id: 'craveman-item-005', cat: cravemanBowlsCat.id,  station: 'craveman-grill', name: 'Chicken Karahi Bowl',     price: 115000, desc: 'Wok-finished karahi chicken, basmati, raita, coriander.' },
    // Wraps
    { id: 'craveman-item-006', cat: cravemanWrapsCat.id,  station: 'craveman-grill', name: 'Karahi Wrap',             price: 110000, desc: 'Slow-cooked karahi chicken, paratha wrap, green chutney.' },
    { id: 'craveman-item-007', cat: cravemanWrapsCat.id,  station: 'craveman-grill', name: 'Tikka Fusion Wrap',       price: 115000, desc: 'Tikka chicken, coleslaw, cheese, whole wheat tortilla.' },
    { id: 'craveman-item-008', cat: cravemanWrapsCat.id,  station: 'craveman-grill', name: 'Seekh Roll',              price: 120000, desc: 'Double seekh, laccha paratha, mint chutney, raw onion.' },
    // Combos
    { id: 'craveman-item-009', cat: cravemanCombosCat.id, station: 'craveman-grill', name: 'The Craveman Combo',      price: 195000, desc: 'Seekh bowl + karahi wrap + sweet lassi. The full meal.' },
    { id: 'craveman-item-010', cat: cravemanCombosCat.id, station: 'craveman-grill', name: 'Family Daal-Roti Box',    price: 280000, desc: 'Daal, basmati, 4 paratha, raita, salad, pickle. Feeds 2–3.' },
    // Sides & drinks
    { id: 'craveman-item-011', cat: cravemanSidesCat.id,  station: 'craveman-cold',  name: 'Raita',                   price: 20000,  desc: 'House-made, cucumber, cumin.' },
    { id: 'craveman-item-012', cat: cravemanSidesCat.id,  station: 'craveman-cold',  name: 'Achaar (3 pcs)',          price: 15000,  desc: 'Mixed pickle selection.' },
    { id: 'craveman-item-013', cat: cravemanSidesCat.id,  station: 'craveman-drinks', name: 'Sweet Lassi',            price: 35000,  desc: 'Full-fat yoghurt, rosewater, pistachio.' },
    { id: 'craveman-item-014', cat: cravemanSidesCat.id,  station: 'craveman-drinks', name: 'Salted Lassi',           price: 30000,  desc: 'Chilled salted buttermilk, cumin.' },
    { id: 'craveman-item-015', cat: cravemanSidesCat.id,  station: 'craveman-drinks', name: 'Mineral Water',          price: 10000,  desc: '500ml.' },
  ]

  for (const [i, item] of cravemanItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: craveman.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Craveman menu seeded')

  // ─── GARNISH STATION menu ─────────────────────────────────────────────────
  // Outdoor walk-up cart. Build-your-own bowls/wraps.

  const gsBowlsCat = await prisma.category.upsert({
    where: { id: 'gs-bowls' }, update: { sortOrder: 0 },
    create: { id: 'gs-bowls', conceptId: garnishStation.id, name: 'Build Your Bowl', sortOrder: 0 },
  })
  const gsWrapsCat = await prisma.category.upsert({
    where: { id: 'gs-wraps' }, update: { sortOrder: 1 },
    create: { id: 'gs-wraps', conceptId: garnishStation.id, name: 'Wraps', sortOrder: 1 },
  })
  const gsToppingsCat = await prisma.category.upsert({
    where: { id: 'gs-toppings' }, update: { sortOrder: 2 },
    create: { id: 'gs-toppings', conceptId: garnishStation.id, name: 'Proteins & Add-ons', sortOrder: 2 },
  })
  const gsDrinksCat = await prisma.category.upsert({
    where: { id: 'gs-drinks' }, update: { sortOrder: 3 },
    create: { id: 'gs-drinks', conceptId: garnishStation.id, name: 'Drinks', sortOrder: 3 },
  })

  const gsItems = [
    { id: 'gs-item-001', cat: gsBowlsCat.id,    station: 'garnish-station-cart', name: 'Classic Bowl',         price: 65000, desc: 'Lettuce base, 3 toppings of your choice, house dressing.' },
    { id: 'gs-item-002', cat: gsBowlsCat.id,    station: 'garnish-station-cart', name: 'Loaded Bowl',          price: 90000, desc: 'Grain base, 5 toppings, protein, premium sauce.' },
    { id: 'gs-item-003', cat: gsBowlsCat.id,    station: 'garnish-station-cart', name: 'Mini Bowl',            price: 45000, desc: 'Small portion, 2 toppings, dressing.' },
    { id: 'gs-item-004', cat: gsWrapsCat.id,    station: 'garnish-station-cart', name: 'Classic Wrap',         price: 75000, desc: 'Whole wheat tortilla, 3 fillings, house sauce.' },
    { id: 'gs-item-005', cat: gsWrapsCat.id,    station: 'garnish-station-cart', name: 'Loaded Wrap',          price: 95000, desc: 'Tortilla, 4 fillings, protein, premium sauce.' },
    { id: 'gs-item-006', cat: gsToppingsCat.id, station: 'garnish-station-cart', name: 'Grilled Chicken (+)',  price: 15000, desc: 'Add grilled chicken strips.' },
    { id: 'gs-item-007', cat: gsToppingsCat.id, station: 'garnish-station-cart', name: 'Feta Cheese (+)',      price: 10000, desc: 'Crumbled feta.' },
    { id: 'gs-item-008', cat: gsToppingsCat.id, station: 'garnish-station-cart', name: 'Avocado (+)',          price: 15000, desc: 'Fresh sliced avocado.' },
    { id: 'gs-item-009', cat: gsToppingsCat.id, station: 'garnish-station-cart', name: 'Boiled Egg (+)',       price: 10000, desc: 'Two halved boiled eggs.' },
    { id: 'gs-item-010', cat: gsDrinksCat.id,   station: 'garnish-station-cart', name: 'Sparkling Water',      price: 15000, desc: '500ml.' },
    { id: 'gs-item-011', cat: gsDrinksCat.id,   station: 'garnish-station-cart', name: 'Fresh Juice',          price: 30000, desc: 'Seasonal, daily rotation.' },
  ]

  for (const [i, item] of gsItems.entries()) {
    await prisma.menuItem.upsert({
      where: { id: item.id }, update: {},
      create: {
        id: item.id, conceptId: garnishStation.id,
        categoryId: item.cat, name: item.name,
        description: item.desc, priceCents: item.price,
        isAvailable: true, displayOrder: i, stationId: item.station,
      },
    })
  }
  console.info('✓ Garnish Station menu seeded')

  // ─── Tables (Simmer restaurant) ───────────────────────────────────────────

  const tableDefs = [
    { label: 'T1',    capacity: 2, floorSection: 'Main' },
    { label: 'T2',    capacity: 4, floorSection: 'Main' },
    { label: 'T3',    capacity: 4, floorSection: 'Main' },
    { label: 'T4',    capacity: 6, floorSection: 'Main' },
    { label: 'T5',    capacity: 2, floorSection: 'Window' },
    { label: 'T6',    capacity: 4, floorSection: 'Window' },
    { label: 'T7',    capacity: 2, floorSection: 'Window' },
    { label: 'Bar-1', capacity: 1, floorSection: 'Bar' },
    { label: 'Bar-2', capacity: 1, floorSection: 'Bar' },
    { label: 'Bar-3', capacity: 1, floorSection: 'Bar' },
    { label: 'Bar-4', capacity: 1, floorSection: 'Bar' },
  ]

  for (const t of tableDefs) {
    await prisma.table.upsert({
      where: { id: `simmer-${t.label.toLowerCase()}` },
      update: {},
      create: {
        id: `simmer-${t.label.toLowerCase()}`,
        conceptId: simmer.id,
        ...t,
        status: 'available',
      },
    })
  }

  console.info('✓ Simmer tables seeded')
  console.info('\n✅ Seed complete')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(() => {
    void prisma.$disconnect()
  })
