// Idempotent data importer for GS Foods.
// Pulls structured data from the operator's business plan (concepts, service
// hours, categories, menu items, inventory ingredients, suppliers, CRM
// segments, recipes) and pushes it into the DB via Prisma upserts. Re-run
// safely after manual edits — uses stable IDs so existing rows update in
// place rather than duplicate.
//
// Run: npx tsx scripts/import-gsfoods.ts

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Helpers ─────────────────────────────────────────────────────────────────────
const PKR = (rupees: number) => Math.round(rupees * 100)        // → paisa
const HHMM = (h: number, m: number) => h * 60 + m               // → minutes since midnight
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function run() {
  console.log('▸ GS Foods data import starting…')

  // ── 1. SUPPLIERS ────────────────────────────────────────────────────────
  // From the contacts page of the business plan.
  const suppliers = [
    { id: 'sup-packaging-hub',   name: 'Packaging Hub',          phone: '+92 312 947 195',  address: 'Lahore',  notes: 'Online: packaginghub.pk' },
    { id: 'sup-ecopak',          name: 'EcoPak',                 phone: '+92 333 845 9500', address: 'Karachi', notes: 'Eco-friendly packaging — ecopakonline.com' },
    { id: 'sup-pack-it-up',      name: 'Pack It Up',             phone: '+92 322 262 0169', address: 'Karachi', notes: 'Containers + utensils' },
    { id: 'sup-cutlery-store',   name: 'Premium Cutlery Store',  phone: '+92 301 864 0019', address: 'Lahore',  notes: 'Tableware + silverware' },
    { id: 'sup-local-produce',   name: 'Local Produce Vendor',   address: 'Karachi', notes: 'Daily fresh produce — placeholder, replace with real vendor' },
    { id: 'sup-meat-supplier',   name: 'Meat Supplier',          address: 'Karachi', notes: 'Halal meats — placeholder' },
    { id: 'sup-dairy-supplier',  name: 'Dairy Supplier',         address: 'Karachi', notes: 'Milk, butter, cream — placeholder' },
    { id: 'sup-dry-goods',       name: 'Dry Goods Wholesaler',   address: 'Karachi', notes: 'Spices, grains, lentils, oils — placeholder' },
  ]
  for (const s of suppliers) {
    await prisma.supplier.upsert({
      where:  { id: s.id },
      update: { name: s.name, phone: s.phone ?? null, email: null, address: s.address ?? null, notes: s.notes ?? null },
      create: { id: s.id, name: s.name, phone: s.phone ?? null, address: s.address ?? null, notes: s.notes ?? null, paymentTermsDays: 30 },
    })
  }
  console.log(`  ✓ ${suppliers.length} suppliers`)

  // ── 2. CONCEPTS ─────────────────────────────────────────────────────────
  // Upsert by slug. Adds Flipd (mentioned in plan but missing from DB) and
  // enriches existing brands with positioning copy.
  const concepts = [
    {
      slug: 'simmer',
      name: 'Simmer',
      type: 'restaurant' as const,
      description: 'Approachable but elegant mocktails + small plates following a local and seasonal philosophy. Plated service.',
      heroTagline: 'Slow nights, plated softly.',
      primaryColor: '#2D4A3E',
      taxRate: 17,
      lateNight: false,        // closes at midnight
    },
    {
      slug: 'stax',
      name: 'Stax',
      type: 'digital' as const,
      description: 'Upscale sandwich brand — house-made rolls and sauces. Smashed, stacked, sauced.',
      heroTagline: 'Smashed, stacked, sauced.',
      primaryColor: '#D4581A',
      taxRate: 17,
      lateNight: true,
    },
    {
      slug: 'strata',
      name: 'Strata',
      type: 'digital' as const,
      description: 'Chef-driven, high-protein bowls and wraps. Clean ingredients, healthy and flavorful.',
      heroTagline: 'Clean, layered, performance-built.',
      primaryColor: '#4A7C59',
      taxRate: 17,
      lateNight: false,
    },
    {
      slug: 'craveman',
      name: 'Craveman',
      type: 'digital' as const,
      description: 'Indulgent desi-fusion bowls and wraps in new flavors. For the masses craving customizable global flavors.',
      heroTagline: 'Cravings, on demand.',
      primaryColor: '#8B1A1A',
      taxRate: 17,
      lateNight: true,
    },
    {
      slug: 'flipd',
      name: 'Flipd',
      type: 'digital' as const,
      description: 'Burger brand competing with Fatman and Gogos. Buttermilk-brined, hand-breaded, hot.',
      heroTagline: 'Buttermilk-brined, hand-breaded, hot.',
      primaryColor: '#EA580C',
      taxRate: 17,
      lateNight: true,
    },
    {
      slug: 'garnish-station',
      name: 'Garnish Station',
      type: 'cart' as const,
      description: 'Top-your-own bowls and wraps from a physical outdoor cart. DIY unlimited toppings.',
      heroTagline: 'Top your own. Eat your own.',
      primaryColor: '#C4A24A',
      taxRate: 17,
      lateNight: false,
    },
  ]

  const conceptIdBySlug = new Map<string, string>()
  for (const c of concepts) {
    const row = await prisma.concept.upsert({
      where:  { slug: c.slug },
      update: {
        name: c.name,
        type: c.type,
        description: c.description,
        heroTagline: c.heroTagline,
        primaryColor: c.primaryColor,
        taxRate: c.taxRate,
        storefrontVisible: true,
      },
      create: {
        slug: c.slug,
        name: c.name,
        type: c.type,
        description: c.description,
        heroTagline: c.heroTagline,
        primaryColor: c.primaryColor,
        taxRate: c.taxRate,
        storefrontVisible: true,
      },
    })
    conceptIdBySlug.set(c.slug, row.id)
  }
  console.log(`  ✓ ${concepts.length} concepts`)

  // ── 3. SERVICE HOURS ───────────────────────────────────────────────────
  // Lunch 12:30–14:30 + Dinner 19:00–24:00 daily.
  // Late-night brands (Stax, Craveman, Flipd) close at midnight (1440); the
  // schema's closeMin tops out at 1440. Shift end-of-service is handled by
  // operator on a per-day basis if they want past-midnight rows.
  for (const c of concepts) {
    for (let dow = 0; dow < 7; dow++) {
      // Lunch
      await prisma.serviceHours.upsert({
        where:  { conceptId_dayOfWeek_openMin: { conceptId: conceptIdBySlug.get(c.slug)!, dayOfWeek: dow, openMin: HHMM(12, 30) } },
        update: { closeMin: HHMM(14, 30) },
        create: { conceptId: conceptIdBySlug.get(c.slug)!, dayOfWeek: dow, openMin: HHMM(12, 30), closeMin: HHMM(14, 30) },
      })
      // Dinner — closes at midnight (1440)
      await prisma.serviceHours.upsert({
        where:  { conceptId_dayOfWeek_openMin: { conceptId: conceptIdBySlug.get(c.slug)!, dayOfWeek: dow, openMin: HHMM(19, 0) } },
        update: { closeMin: 1440 },
        create: { conceptId: conceptIdBySlug.get(c.slug)!, dayOfWeek: dow, openMin: HHMM(19, 0), closeMin: 1440 },
      })
    }
  }
  console.log(`  ✓ service hours (lunch + dinner) for ${concepts.length} concepts × 7 days`)

  // ── 4. CATEGORIES + MENU ITEMS ─────────────────────────────────────────
  type Item = { name: string; description?: string; price: number; dietary?: string[]; allergens?: string[]; spice?: number }
  const menus: Record<string, Array<{ category: string; items: Item[] }>> = {
    simmer: [
      { category: 'Small Plates', items: [
        { name: 'Pommes',            description: 'Thinly sliced potatoes layered with fat, baked, pressed overnight, fried à la minute.',                  price: 850,  dietary: ['vegetarian'], allergens: ['dairy'] },
        { name: 'Panisse',           description: 'Chickpea flour, water, salt — pressed overnight and fried à la minute. Crisp outside, custardy in.',     price: 750,  dietary: ['vegetarian','vegan','gluten_free'] },
        { name: 'Compressed Tomato Panzanella', description: 'Compressed heirloom tomato, charred sourdough, basil oil, aged balsamic.',                       price: 950,  dietary: ['vegetarian'], allergens: ['gluten'] },
        { name: 'Stuffed Dates',     description: 'Medjool dates, whipped goat cheese, candied walnut, date syrup glaze.',                                    price: 800,  dietary: ['vegetarian'], allergens: ['dairy','tree_nuts'] },
      ]},
      { category: 'Larger Plates', items: [
        { name: 'Brine & Dine',      description: 'House brioche, pan-seared brined chicken thigh, green goddess sauce.',                                     price: 1700, allergens: ['gluten','dairy','eggs'] },
        { name: 'Jerk Chicken',      description: 'Marinated jerk chicken thigh, sella rice, scotch bonnet sauce, herb salad.',                               price: 1850, dietary: ['halal','gluten_free'], spice: 3 },
        { name: 'Pan-Seared Mahi',   description: 'Lemon butter, seasonal greens, preserved lemon gremolata.',                                                price: 2100, allergens: ['fish','dairy'] },
        { name: 'Slow-Braised Short Rib', description: 'Six hours in red wine, parsnip mash, jus.',                                                            price: 2500, dietary: ['halal'], allergens: ['dairy'] },
      ]},
      { category: 'Mocktails', items: [
        { name: 'Tamarind Spritz',   description: 'House tamarind cordial, soda, lime oil, dehydrated tamarind wheel.',                                       price: 650,  dietary: ['vegan','gluten_free'] },
        { name: 'Raisin Old Fashioned', description: 'Raisin reduction, smoked tea, orange peel.',                                                            price: 700,  dietary: ['vegan','gluten_free'] },
        { name: 'Ginger Highball',   description: 'Fresh ginger shrub, soda, lemon.',                                                                         price: 600,  dietary: ['vegan','gluten_free'] },
      ]},
      { category: 'Desserts', items: [
        { name: 'Banana Pudding',    description: 'Layered banana custard, vanilla wafer, brown butter crumb.',                                               price: 700,  dietary: ['vegetarian'], allergens: ['dairy','eggs','gluten'] },
        { name: 'Date Coffee Cake',  description: 'Sticky date cake, date-syrup caramel, espresso cream.',                                                    price: 750,  dietary: ['vegetarian'], allergens: ['dairy','eggs','gluten'] },
      ]},
    ],
    stax: [
      { category: 'Smash Stax', items: [
        { name: 'MCD Stack',         description: 'House brioche, double smash patty, ketchup, house mustard, diced white onion, pickles.',                   price: 850,  dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'Pub Stack',         description: 'House brioche, thick patty, signature seasonal flavor.',                                                   price: 1100, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'Smash Stack',       description: 'House brioche, double smash patty, signature seasonal flavor.',                                            price: 1150, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
      ]},
      { category: 'Golden Stax', items: [
        { name: 'C Stack',           description: 'House brioche, rice and tapioca fried chicken, signature seasonal flavor.',                                price: 950,  dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'CC Stack',          description: 'House brioche, double-stack rice and tapioca fried chicken cutlet, signature seasonal flavor.',            price: 1250, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'Max Stack',         description: 'Brined and pan-seared chicken thigh sandwich.',                                                            price: 1100, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
      ]},
      { category: 'Build Your Own', items: [
        { name: 'BYO — Pub Stack',   description: 'House brioche, thick patty. Customize from all available sauces + toppings.',                              price: 1200, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'BYO — Smash Stack', description: 'House brioche, double smash patty. Customize from all available sauces + toppings.',                       price: 1300, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
      ]},
      { category: 'Side Stax', items: [
        { name: 'Pommes Stax',       description: 'Bake-layered potato + fat in hotel pan, pressed overnight, cut before service, fried à la minute.',         price: 450,  dietary: ['vegetarian'], allergens: ['dairy'] },
        { name: 'Roasties',          description: 'Potato ends boiled and cooled overnight, then roasted or fried à la minute.',                              price: 350,  dietary: ['vegan','gluten_free'] },
        { name: 'Loaded Fries',      description: 'Pommes Stax, melted cheddar, pickled onions, garlic aioli, herbs.',                                        price: 750,  dietary: ['vegetarian'], allergens: ['dairy','eggs'] },
      ]},
      { category: 'Combos', items: [
        { name: 'Smash Combo · 2 + Fries', description: 'Two smash burgers + Pommes Stax. Save vs. ordering separately.',                                     price: 1650, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
      ]},
    ],
    strata: [
      { category: 'Bowls', items: [
        { name: 'Performance Bowl',  description: 'Quinoa, grilled chicken, tahini, charred broccoli, pickled onion.',                                        price: 1100, dietary: ['halal','gluten_free'], allergens: ['sesame'] },
        { name: 'Protein Stack',     description: 'Lean beef, sweet potato, avocado, rocket, salsa verde.',                                                   price: 1250, dietary: ['halal','gluten_free'] },
        { name: 'Mediterranean Bowl', description: 'Lamb kofta, brown rice, hummus, cucumber, mint yoghurt.',                                                  price: 1300, dietary: ['halal'], allergens: ['dairy','sesame'] },
      ]},
      { category: 'Wraps', items: [
        { name: 'Power Wrap',        description: 'Egg whites, spinach, hummus, charred peppers, whole-wheat flatbread.',                                     price: 850,  dietary: ['vegetarian'], allergens: ['gluten','eggs','sesame'] },
        { name: 'Protein Wrap',      description: 'Grilled chicken, avocado, lettuce, garlic yoghurt, whole-wheat flatbread.',                                price: 950,  dietary: ['halal'], allergens: ['gluten','dairy'] },
      ]},
      { category: 'Add-ons', items: [
        { name: 'Extra Protein',     description: 'Add a second serving of any protein.',                                                                     price: 350,  dietary: ['halal','gluten_free'] },
        { name: 'Side Salad',        description: 'Mixed leaves, lemon vinaigrette.',                                                                         price: 300,  dietary: ['vegan','gluten_free'] },
      ]},
    ],
    craveman: [
      { category: 'Bowls', items: [
        { name: 'Karahi Bowl',       description: 'Slow-cooked chicken karahi over basmati, mint chutney, fried onion.',                                      price: 950,  dietary: ['halal'], spice: 2 },
        { name: 'Achari Tikka Bowl', description: 'Tangy pickle-spiced tikka, biryani-rice base, kachumber.',                                                 price: 990,  dietary: ['halal'], spice: 3 },
        { name: 'Beef Nihari Bowl',  description: 'Eight-hour beef nihari, basmati, ginger julienne, lemon.',                                                  price: 1100, dietary: ['halal'], spice: 2 },
      ]},
      { category: 'Wraps', items: [
        { name: 'Nihari Wrap',       description: 'Eight-hour beef nihari, ginger, naan-wrapped, mint-yoghurt drizzle.',                                       price: 850,  dietary: ['halal'], allergens: ['gluten','dairy'], spice: 2 },
        { name: 'Tikka Roll',        description: 'Chicken tikka, charred onion, garlic chutney, paratha.',                                                   price: 750,  dietary: ['halal'], allergens: ['gluten','dairy'], spice: 2 },
      ]},
      { category: 'Sides + Sweets', items: [
        { name: 'Loaded Cheese Fries', description: 'Crinkle fries, cheddar sauce, jalapeño, pickled onion.',                                                 price: 550,  dietary: ['vegetarian'], allergens: ['dairy'] },
        { name: 'Gulab Jamun Cheesecake', description: 'Cardamom cheesecake, gulab jamun chunks, rose syrup.',                                                price: 600,  dietary: ['vegetarian'], allergens: ['dairy','eggs','gluten'] },
      ]},
    ],
    flipd: [
      { category: 'Burgers', items: [
        { name: 'Buttermilk Sandwich', description: 'Hand-breaded, brioche bun, slaw, pickles.',                                                              price: 850,  dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'Hot Honey Tenders',   description: 'Three buttermilk tenders, hot honey glaze, dipping sauce.',                                              price: 990,  dietary: ['halal'], allergens: ['gluten','dairy','eggs'], spice: 2 },
        { name: 'Loaded Waffle Plate', description: 'Crispy chicken, maple, pickles, on a savoury waffle.',                                                   price: 1200, dietary: ['halal'], allergens: ['gluten','dairy','eggs'] },
        { name: 'Double Crunch',       description: 'Two hand-breaded patties, slaw, pickles, hot sauce.',                                                    price: 1350, dietary: ['halal'], allergens: ['gluten','dairy','eggs'], spice: 2 },
      ]},
      { category: 'Sides', items: [
        { name: 'Crinkle Fries',       description: 'Seasoned crinkle-cut, side of dip.',                                                                     price: 350,  dietary: ['vegan'] },
        { name: 'Mac & Cheese',        description: 'Three-cheese mac, breadcrumb top.',                                                                       price: 550,  dietary: ['vegetarian'], allergens: ['gluten','dairy'] },
      ]},
    ],
    'garnish-station': [
      { category: 'Bowls', items: [
        { name: 'Mini Bowl',         description: 'Light option. 2 toppings, dressing.',                                                                      price: 450,  dietary: ['vegan','gluten_free'] },
        { name: 'Classic Bowl',      description: 'Lettuce base, 3 toppings, house dressing.',                                                                price: 650,  dietary: ['vegan','gluten_free'] },
        { name: 'Loaded Bowl',       description: 'Grain base, 5 toppings, premium sauce.',                                                                   price: 900,  dietary: ['vegetarian'] },
      ]},
      { category: 'Wraps', items: [
        { name: 'Garnish Wrap',      description: 'Whole-wheat wrap, choose 5 toppings, choose sauce.',                                                       price: 850,  dietary: ['vegetarian'], allergens: ['gluten'] },
      ]},
      { category: 'Premium Add-ons', items: [
        { name: 'Grilled Chicken (+)', description: 'Add grilled chicken strips.',                                                                            price: 250,  dietary: ['halal','gluten_free'] },
        { name: 'Falafel (+)',       description: 'Add four house-made falafel.',                                                                              price: 200,  dietary: ['vegan'], allergens: ['sesame'] },
        { name: 'Avocado (+)',       description: 'Add half avocado, sliced.',                                                                                price: 250,  dietary: ['vegan','gluten_free'] },
      ]},
    ],
  }

  let categoryCount = 0, itemCount = 0
  const menuItemIdByKey = new Map<string, string>()  // `${conceptSlug}:${itemName}` → id (for recipes later)

  for (const conceptSlug of Object.keys(menus)) {
    const conceptId = conceptIdBySlug.get(conceptSlug)!
    const sections = menus[conceptSlug]!
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s]!
      const catId = `cat-${conceptSlug}-${slugify(section.category)}`
      await prisma.category.upsert({
        where:  { id: catId },
        update: { name: section.category, sortOrder: s, isActive: true },
        create: { id: catId, conceptId, name: section.category, sortOrder: s, isActive: true },
      })
      categoryCount++
      for (let i = 0; i < section.items.length; i++) {
        const it = section.items[i]!
        const itemId = `mi-${conceptSlug}-${slugify(it.name)}`
        await prisma.menuItem.upsert({
          where:  { id: itemId },
          update: {
            name: it.name,
            description: it.description ?? null,
            priceCents: PKR(it.price),
            isAvailable: true,
            displayOrder: i,
            allergens: it.allergens ?? [],
            dietary: it.dietary ?? [],
            spiceLevel: it.spice ?? null,
          },
          create: {
            id: itemId,
            conceptId,
            categoryId: catId,
            name: it.name,
            description: it.description ?? null,
            priceCents: PKR(it.price),
            isAvailable: true,
            displayOrder: i,
            allergens: it.allergens ?? [],
            dietary: it.dietary ?? [],
            spiceLevel: it.spice ?? null,
          },
        })
        menuItemIdByKey.set(`${conceptSlug}:${it.name}`, itemId)
        itemCount++
      }
    }
  }
  console.log(`  ✓ ${categoryCount} categories, ${itemCount} menu items`)

  // ── 5. INVENTORY ITEMS ─────────────────────────────────────────────────
  // Compact representation: [name, unit, parLevel, supplierKey?]
  type Inv = [string, string, number, string?]
  const dryGoods: Inv[]  = [
    ['Wheat Flour',          'kg',  20, 'sup-dry-goods'],
    ['Basmati Rice',         'kg',  30, 'sup-dry-goods'],
    ['Sella Rice',           'kg',  20, 'sup-dry-goods'],
    ['Maize / Corn',         'kg',  10, 'sup-dry-goods'],
    ['Chickpea Flour',       'kg',  10, 'sup-dry-goods'],
    ['Lentil (Masoor)',      'kg',  10, 'sup-dry-goods'],
    ['Mung Dal',             'kg',  10, 'sup-dry-goods'],
    ['Mash / Black Gram',    'kg',  10, 'sup-dry-goods'],
    ['Pearl Millet (Bajra)', 'kg',  5,  'sup-dry-goods'],
    ['Sorghum (Jowar)',      'kg',  5,  'sup-dry-goods'],
    ['Flaxseed',             'kg',  3,  'sup-dry-goods'],
    ['Sesame (Til)',         'kg',  3,  'sup-dry-goods'],
    ['Sunflower Seed',       'kg',  3,  'sup-dry-goods'],
    ['Pumpkin Seed',         'kg',  3,  'sup-dry-goods'],
    ['Sugar (White)',        'kg',  10, 'sup-dry-goods'],
    ['Brown Sugar',          'kg',  5,  'sup-dry-goods'],
    ['Jaggery (Gur)',        'kg',  3,  'sup-dry-goods'],
    ['Honey',                'kg',  3,  'sup-dry-goods'],
    ['Salt (Table)',         'kg',  10, 'sup-dry-goods'],
    ['Salt (Sea)',           'kg',  3,  'sup-dry-goods'],
  ]
  const fruits: Inv[] = [
    ['Banana',      'kg', 10, 'sup-local-produce'],
    ['Dates',       'kg',  5, 'sup-local-produce'],
    ['Lemon',       'kg', 10, 'sup-local-produce'],
    ['Tamarind',    'kg',  3, 'sup-local-produce'],
    ['Raisins',     'kg',  3, 'sup-dry-goods'],
    ['Strawberry',  'kg',  3, 'sup-local-produce'],
    ['Mulberry',    'kg',  2, 'sup-local-produce'],
    ['Mango',       'kg',  10,'sup-local-produce'],
    ['Lychee',      'kg',  3, 'sup-local-produce'],
    ['Peach',       'kg',  3, 'sup-local-produce'],
    ['Plum',        'kg',  3, 'sup-local-produce'],
    ['Apricot',     'kg',  2, 'sup-local-produce'],
    ['Watermelon',  'kg', 15, 'sup-local-produce'],
    ['Muskmelon',   'kg', 10, 'sup-local-produce'],
    ['Grapes',      'kg',  5, 'sup-local-produce'],
    ['Fig',         'kg',  2, 'sup-local-produce'],
    ['Guava',       'kg',  5, 'sup-local-produce'],
    ['Pomegranate', 'kg',  5, 'sup-local-produce'],
    ['Sweet Lime',  'kg',  5, 'sup-local-produce'],
    ['Kinnow',      'kg',  10,'sup-local-produce'],
    ['Orange',      'kg',  5, 'sup-local-produce'],
    ['Grapefruit',  'kg',  3, 'sup-local-produce'],
    ['Persimmon',   'kg',  3, 'sup-local-produce'],
    ['Apple',       'kg',  10,'sup-local-produce'],
    ['Pear',        'kg',  5, 'sup-local-produce'],
    ['Coconut',     'kg',  5, 'sup-local-produce'],
    ['Papaya',      'kg',  5, 'sup-local-produce'],
    ['Chikoo',      'kg',  3, 'sup-local-produce'],
    ['Amla',        'kg',  2, 'sup-local-produce'],
    ['Walnut',      'kg',  3, 'sup-dry-goods'],
    ['Almond',      'kg',  3, 'sup-dry-goods'],
    ['Pistachio',   'kg',  3, 'sup-dry-goods'],
  ]
  const vegetables: Inv[] = [
    ['Onion',           'kg', 25, 'sup-local-produce'],
    ['Potato',          'kg', 30, 'sup-local-produce'],
    ['Tomato',          'kg', 20, 'sup-local-produce'],
    ['Garlic',          'kg',  5, 'sup-local-produce'],
    ['Ginger',          'kg',  5, 'sup-local-produce'],
    ['Green Chili',     'kg',  3, 'sup-local-produce'],
    ['Okra',            'kg',  5, 'sup-local-produce'],
    ['Amaranth',        'kg',  3, 'sup-local-produce'],
    ['Spinach',         'kg',  5, 'sup-local-produce'],
    ['Fenugreek (Methi)', 'kg', 3, 'sup-local-produce'],
    ['Kohlrabi',        'kg',  3, 'sup-local-produce'],
    ['Arbi (Taro)',     'kg',  3, 'sup-local-produce'],
    ['Carrot',          'kg', 10, 'sup-local-produce'],
    ['Radish',          'kg',  5, 'sup-local-produce'],
    ['Turnip',          'kg',  5, 'sup-local-produce'],
    ['Beetroot',        'kg',  5, 'sup-local-produce'],
    ['Cauliflower',     'kg',  8, 'sup-local-produce'],
    ['Cabbage',         'kg',  8, 'sup-local-produce'],
    ['Broccoli',        'kg',  5, 'sup-local-produce'],
    ['Peas',            'kg',  5, 'sup-local-produce'],
    ['Green Beans',     'kg',  5, 'sup-local-produce'],
    ['Zucchini',        'kg',  5, 'sup-local-produce'],
    ['Eggplant',        'kg',  5, 'sup-local-produce'],
    ['Bottle Gourd',    'kg',  5, 'sup-local-produce'],
    ['Ridge Gourd',     'kg',  5, 'sup-local-produce'],
    ['Bitter Gourd',    'kg',  3, 'sup-local-produce'],
    ['Cucumber',        'kg',  8, 'sup-local-produce'],
    ['Sweet Corn',      'kg',  5, 'sup-local-produce'],
    ['Pumpkin',         'kg',  5, 'sup-local-produce'],
    ['Sweet Potato',    'kg',  5, 'sup-local-produce'],
    ['Bell Pepper',     'kg',  3, 'sup-local-produce'],
    ['Avocado',         'kg',  3, 'sup-local-produce'],
    ['Lettuce',         'kg',  5, 'sup-local-produce'],
    ['Rocket / Arugula','kg',  2, 'sup-local-produce'],
  ]
  const herbs: Inv[] = [
    ['Basil',     'kg', 1, 'sup-local-produce'],
    ['Mint',      'kg', 1, 'sup-local-produce'],
    ['Coriander', 'kg', 2, 'sup-local-produce'],
    ['Dill',      'kg', 1, 'sup-local-produce'],
    ['Celery',    'kg', 1, 'sup-local-produce'],
    ['Thyme',     'kg', 1, 'sup-local-produce'],
    ['Lemongrass','kg', 1, 'sup-local-produce'],
  ]
  const spices: Inv[] = [
    ['Black Pepper',         'kg', 1,   'sup-dry-goods'],
    ['Cumin (Jeera)',        'kg', 2,   'sup-dry-goods'],
    ['Coriander Seed',       'kg', 2,   'sup-dry-goods'],
    ['Turmeric (Haldi)',     'kg', 1,   'sup-dry-goods'],
    ['Red Chili Powder',     'kg', 2,   'sup-dry-goods'],
    ['Cardamom (Elaichi)',   'kg', 0.5, 'sup-dry-goods'],
    ['Clove',                'kg', 0.5, 'sup-dry-goods'],
    ['Cinnamon',             'kg', 0.5, 'sup-dry-goods'],
    ['Fennel (Saunf)',       'kg', 1,   'sup-dry-goods'],
    ['Fenugreek Seed',       'kg', 0.5, 'sup-dry-goods'],
    ['Nigella (Kalonji)',    'kg', 0.5, 'sup-dry-goods'],
    ['Carom (Ajwain)',       'kg', 0.5, 'sup-dry-goods'],
    ['Bay Leaf',             'kg', 0.2, 'sup-dry-goods'],
    ['Star Anise',           'kg', 0.2, 'sup-dry-goods'],
    ['Saffron (Zafran)',     'g',  10,  'sup-dry-goods'],
  ]
  const dairyEggsOils: Inv[] = [
    ['Milk',          'L',  20, 'sup-dairy-supplier'],
    ['Cream',         'L',  5,  'sup-dairy-supplier'],
    ['Butter',        'kg', 5,  'sup-dairy-supplier'],
    ['Paneer',        'kg', 3,  'sup-dairy-supplier'],
    ['Khoya',         'kg', 2,  'sup-dairy-supplier'],
    ['Ghee',          'kg', 3,  'sup-dairy-supplier'],
    ['Eggs',          'pcs',60, 'sup-dairy-supplier'],
    ['Yoghurt',       'kg', 5,  'sup-dairy-supplier'],
    ['Cheddar',       'kg', 3,  'sup-dairy-supplier'],
    ['Mustard Oil',   'L',  5,  'sup-dry-goods'],
    ['Sunflower Oil', 'L', 10,  'sup-dry-goods'],
    ['Canola Oil',    'L', 10,  'sup-dry-goods'],
    ['Coconut Oil',   'L',  3,  'sup-dry-goods'],
    ['Olive Oil',     'L',  3,  'sup-dry-goods'],
  ]
  const proteins: Inv[] = [
    ['Chicken Thigh', 'kg', 15, 'sup-meat-supplier'],
    ['Chicken Breast','kg', 15, 'sup-meat-supplier'],
    ['Chicken Whole', 'kg', 10, 'sup-meat-supplier'],
    ['Beef Mince (80/20)','kg', 15, 'sup-meat-supplier'],
    ['Beef Brisket',  'kg', 10, 'sup-meat-supplier'],
    ['Lamb Shoulder', 'kg', 8,  'sup-meat-supplier'],
    ['Mahi (fish)',   'kg', 5,  'sup-meat-supplier'],
  ]
  const condimentsAcids: Inv[] = [
    ['Vinegar (White)',     'L',  3, 'sup-dry-goods'],
    ['Apple Cider Vinegar', 'L',  2, 'sup-dry-goods'],
    ['Tamarind Paste',      'kg', 1, 'sup-dry-goods'],
    ['Soy Sauce',           'L',  2, 'sup-dry-goods'],
    ['Worcestershire Sauce','L',  1, 'sup-dry-goods'],
    ['Pickle Base (Achar)', 'kg', 2, 'sup-dry-goods'],
    ['Fermented Chili Paste','kg', 1, 'sup-dry-goods'],
    ['Date Syrup',          'L',  1, 'sup-dry-goods'],
    ['Glucose Syrup',       'L',  1, 'sup-dry-goods'],
    ['Baking Powder',       'kg', 0.5, 'sup-dry-goods'],
    ['Baking Soda',         'kg', 0.5, 'sup-dry-goods'],
    ['Gelatin',             'kg', 0.5, 'sup-dry-goods'],
    ['Agar Agar',           'kg', 0.2, 'sup-dry-goods'],
    ['Pectin',              'kg', 0.2, 'sup-dry-goods'],
    ['Xanthan Gum',         'kg', 0.2, 'sup-dry-goods'],
    ['Citric Acid',         'kg', 0.5, 'sup-dry-goods'],
  ]
  const packaging: Inv[] = [
    ['Brioche Buns (6-pack)',  'pcs', 30, 'sup-dry-goods'],     // bread supplier later
    ['Takeout Box (Large)',    'pcs', 200, 'sup-ecopak'],
    ['Takeout Box (Medium)',   'pcs', 200, 'sup-ecopak'],
    ['Takeout Box (Small)',    'pcs', 200, 'sup-ecopak'],
    ['Sauce Cups',             'pcs', 500, 'sup-packaging-hub'],
    ['Cutlery Pack',           'pcs', 300, 'sup-pack-it-up'],
    ['Branded Paper Bag',      'pcs', 300, 'sup-packaging-hub'],
  ]

  const allInventory: Inv[] = [
    ...dryGoods, ...fruits, ...vegetables, ...herbs, ...spices,
    ...dairyEggsOils, ...proteins, ...condimentsAcids, ...packaging,
  ]
  for (const [name, unit, par, supKey] of allInventory) {
    const id = `inv-${slugify(name)}`
    await prisma.inventoryItem.upsert({
      where:  { id },
      update: { name, unit, parLevel: par, supplierId: supKey ?? null },
      create: { id, name, unit, parLevel: par, currentStock: 0, supplierId: supKey ?? null },
    })
  }
  console.log(`  ✓ ${allInventory.length} inventory items`)

  // ── 6. CRM SEGMENTS ────────────────────────────────────────────────────
  const segments = [
    { name: 'Carnivores',                description: 'Order from high-protein brand or order extra meat.' },
    { name: 'Omnivores',                 description: 'Regular protein level + love toppings, drinks, desserts.' },
    { name: 'High-protein omnivores',    description: 'High-protein brand but care a lot about variety of toppings, drinks, desserts.' },
    { name: 'Weekend warriors',          description: 'Almost exclusively order on weekends. Families or older customers.' },
    { name: 'Lunch crowd',               description: 'Almost exclusively lunch. Corporate workers / students fueling a busy day.' },
    { name: 'Dinner crowd',              description: 'Almost exclusively dinner. Young professionals or families relying on delivery.' },
    { name: 'Value maximizers',          description: 'Care about big portions, free toppings, drinks, desserts. Convert on recurring discounts.' },
    { name: 'Foodies / Gen Z / social sharers', description: 'Try new things, share experiences, brand spokespeople.' },
    { name: 'Special occasions',         description: 'Eid, Diwali, sports nights, birthday catering — map and market relevant ethnicities.' },
    { name: 'Health-conscious eaters',   description: 'Gym goers, 18–35, high-protein, less price-conscious about clean food.' },
    { name: 'Households',                description: 'Working nuclear families ordering to save time.' },
    { name: 'Experience seekers',        description: 'Curious DHA residents trying new concepts.' },
    { name: 'Premium indulgence buyers', description: 'High-AOV customers adding extras and upgrades.' },
    { name: 'Social hosting buyers',     description: 'Small gatherings and friend dinners.' },
    { name: 'Late-night buyers',         description: 'Impulse solo orders late at night.' },
    { name: 'Corporate / structured buyers', description: 'Office lunches and admin orders.' },
    { name: 'Delivery-fee optimizers',   description: 'Buyers optimizing total cart value to clear free-delivery threshold.' },
    { name: 'Cultural / occasion buyers',description: 'Ramzan, Jummah, sports nights — schedule against the calendar.' },
    { name: 'Habitual buyers',           description: 'Same SKU weekly with none or minor changes.' },
    { name: 'Influencer / viral traffic',description: 'Inbound from creator content or viral posts.' },
  ]
  for (const seg of segments) {
    const id = `seg-${slugify(seg.name)}`
    await prisma.segment.upsert({
      where:  { id },
      update: { name: seg.name, description: seg.description, filters: {} },
      create: { id, name: seg.name, description: seg.description, filters: {} },
    })
  }
  console.log(`  ✓ ${segments.length} CRM segments`)

  // ── 7. RECIPES ─────────────────────────────────────────────────────────
  // Documented in the operator's costing sheet. Linked to existing menu
  // items so /accounting/food-cost has real data to chew on.
  type RecipeSpec = {
    menuKey: string
    servings: number
    portionG: number
    laborMin: number
    ingredients: Array<{ inv: string; qty: number; unit: string; yieldPct?: number }>
  }
  const recipes: RecipeSpec[] = [
    // Jerk Chicken — Strata, large bowl
    { menuKey: 'strata:Performance Bowl', servings: 4, portionG: 600, laborMin: 25, ingredients: [
      { inv: 'inv-chicken-thigh',  qty: 1.5,   unit: 'kg', yieldPct: 0.75 },
      { inv: 'inv-sella-rice',     qty: 1.0,   unit: 'kg', yieldPct: 0.95 },
      { inv: 'inv-coriander',      qty: 0.02,  unit: 'kg', yieldPct: 0.90 },
      { inv: 'inv-lemon',          qty: 0.10,  unit: 'kg', yieldPct: 0.90 },
      { inv: 'inv-olive-oil',      qty: 0.05,  unit: 'L',  yieldPct: 1.0 },
    ]},
    // Sliders — Stax MCD Stack
    { menuKey: 'stax:MCD Stack', servings: 200, portionG: 126, laborMin: 60, ingredients: [
      { inv: 'inv-beef-mince-80-20',  qty: 17.0, unit: 'kg', yieldPct: 1.0 },
      { inv: 'inv-brioche-buns-6-pack', qty: 33.3, unit: 'pcs', yieldPct: 1.0 },     // 200 buns
      { inv: 'inv-cheddar',           qty: 1.5,  unit: 'kg', yieldPct: 1.0 },
      { inv: 'inv-onion',             qty: 1.5,  unit: 'kg', yieldPct: 0.90 },
      { inv: 'inv-vinegar-white',     qty: 1.5,  unit: 'L',  yieldPct: 1.0 },
      { inv: 'inv-sugar-white',       qty: 1.5,  unit: 'kg', yieldPct: 1.0 },
      { inv: 'inv-bay-leaf',          qty: 0.02, unit: 'kg', yieldPct: 1.0 },
    ]},
    // Pommes — Simmer
    { menuKey: 'simmer:Pommes', servings: 8, portionG: 140, laborMin: 90, ingredients: [
      { inv: 'inv-potato', qty: 2.0,  unit: 'kg', yieldPct: 0.85 },
      { inv: 'inv-butter', qty: 0.20, unit: 'kg', yieldPct: 1.0 },
      { inv: 'inv-salt-sea', qty: 0.02, unit: 'kg', yieldPct: 1.0 },
    ]},
    // Panisse — Simmer
    { menuKey: 'simmer:Panisse', servings: 8, portionG: 110, laborMin: 60, ingredients: [
      { inv: 'inv-chickpea-flour', qty: 0.6,  unit: 'kg', yieldPct: 1.0 },
      { inv: 'inv-olive-oil',      qty: 0.10, unit: 'L',  yieldPct: 1.0 },
      { inv: 'inv-salt-table',     qty: 0.02, unit: 'kg', yieldPct: 1.0 },
    ]},
    // Brine & Dine — Simmer
    { menuKey: 'simmer:Brine & Dine', servings: 6, portionG: 280, laborMin: 35, ingredients: [
      { inv: 'inv-chicken-thigh',       qty: 1.2,   unit: 'kg', yieldPct: 0.80 },
      { inv: 'inv-brioche-buns-6-pack', qty: 1.0,   unit: 'pcs', yieldPct: 1.0 },
      { inv: 'inv-yoghurt',             qty: 0.30,  unit: 'kg', yieldPct: 1.0 },
      { inv: 'inv-coriander',           qty: 0.05,  unit: 'kg', yieldPct: 0.85 },
      { inv: 'inv-mint',                qty: 0.03,  unit: 'kg', yieldPct: 0.85 },
      { inv: 'inv-salt-table',          qty: 0.04,  unit: 'kg', yieldPct: 1.0 },
    ]},
  ]

  let recipeCount = 0
  for (const r of recipes) {
    const menuItemId = menuItemIdByKey.get(r.menuKey)
    if (!menuItemId) {
      console.warn(`    ⚠ skipping recipe — menu item missing: ${r.menuKey}`)
      continue
    }
    const recipe = await prisma.recipe.upsert({
      where:  { menuItemId },
      update: { servings: r.servings, portionSizeG: r.portionG, laborMinutes: r.laborMin },
      create: { menuItemId, servings: r.servings, portionSizeG: r.portionG, laborMinutes: r.laborMin },
    })
    // wipe + re-insert ingredients (cascading delete on recipe ensures clean slate)
    await prisma.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } })
    for (const ing of r.ingredients) {
      await prisma.recipeIngredient.create({
        data: {
          recipeId: recipe.id,
          inventoryItemId: ing.inv,
          quantity: ing.qty,
          yieldPct: ing.yieldPct ?? 1.0,
          unit: ing.unit,
        },
      })
    }
    recipeCount++
  }
  console.log(`  ✓ ${recipeCount} recipes (with ingredient links)`)

  console.log('▸ GS Foods data import complete.')
  await prisma.$disconnect()
}

run().catch(async (err) => {
  console.error('▸ import failed:', err)
  await prisma.$disconnect()
  process.exit(1)
})
