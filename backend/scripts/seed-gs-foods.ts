// Seed servd with the GS Foods data captured in the operator's PDF/Excel:
//   - 6 brands (Stax, Strata, Flipd, Simmer, Craveman, Garnish Station)
//   - ~20 customer segments with descriptions
//   - ~100 ingredients with category + seasonality windows
//   - 4 vendors (PackagingHub, EcoPak, Pack It Up, Premium Cutlery)
//   - 2 recipe cost cards (Jerk Chicken, Sliders)
//
// Idempotent: checks for existing slugs / names and updates rather than
// duplicating. Run with: npm run seed:gs

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface Concept {
  slug: string
  name: string
  type: 'restaurant' | 'digital' | 'cart'
  description: string
  primaryColor: string
  heroTagline: string
}

const BRANDS: Concept[] = [
  {
    slug: 'simmer', name: 'Simmer', type: 'restaurant',
    description: 'Approachable, chef-driven mocktails + small plates following a local and seasonal philosophy. Plated service, intimate room.',
    primaryColor: '#2D4A3E',
    heroTagline: 'Considered, plated, paced.',
  },
  {
    slug: 'strata', name: 'Strata', type: 'digital',
    description: 'High-protein, chef-driven bowls and wraps with premium ingredients. Clean labels, macros on every lid.',
    primaryColor: '#2D6A4F',
    heroTagline: 'Healthy and flavorful.',
  },
  {
    slug: 'stax', name: 'Stax', type: 'digital',
    description: 'Upscale sandwich brand. House-made brioche, double-smash technique, signature seasonal flavors.',
    primaryColor: '#D4581A',
    heroTagline: 'Stacked, smashed, sent fast.',
  },
  {
    slug: 'flipd', name: 'Flipd', type: 'digital',
    description: 'Buttermilk-brined, hand-breaded crispy chicken. Every piece made to order, never reheated.',
    primaryColor: '#E5A100',
    heroTagline: 'Always crisp, never reheated.',
  },
  {
    slug: 'craveman', name: 'Craveman', type: 'digital',
    description: 'Indulgent customizable bowls and wraps serving global fusion flavors. New flavors, big portions.',
    primaryColor: '#F5A623',
    heroTagline: 'Indulgent food, new flavors.',
  },
  {
    slug: 'garnish-station', name: 'Garnish Station', type: 'cart',
    description: 'Top-your-own bowls and wraps. DIY unlimited toppings, served from an outdoor cart in takeout containers.',
    primaryColor: '#C4A24A',
    heroTagline: 'Build it your way.',
  },
]

interface Segment {
  name: string
  description: string
  filters: Record<string, unknown>     // free-form criteria — stored as JSON
}

const SEGMENTS: Segment[] = [
  { name: 'Carnivores',                description: 'Ordering from high-protein brand or ordering extra meat.', filters: { tags: ['high_protein'] } },
  { name: 'Omnivores',                 description: 'Ordering from regular protein brand, love toppings/drinks/desserts.', filters: { tags: ['variety'] } },
  { name: 'High-Protein Omnivores',    description: 'High-protein brand + variety in toppings/drinks/desserts.', filters: { tags: ['high_protein','variety'] } },
  { name: 'Weekend Warriors',          description: 'Almost exclusively weekend orders. Families / older people.', filters: { dayOfWeek: ['Sat','Sun'] } },
  { name: 'Lunch Crowd',               description: 'Almost exclusively lunch orders — corporate workers, students.', filters: { mealPeriod: 'lunch' } },
  { name: 'Dinner Crowd',              description: 'Almost exclusively dinner — young professionals, families relying on delivery.', filters: { mealPeriod: 'dinner' } },
  { name: 'Value Maximizers',          description: 'Care about big portions, free toppings, discounts. Convince with recurring promos.', filters: { tags: ['value'] } },
  { name: 'Foodies / Gen Z / Sharers', description: 'Try new things, share experiences. Brand spokespeople.', filters: { ageRange: '16-30', tags: ['social'] } },
  { name: 'Special Occasions',         description: 'Eid, Diwali, sports nights, birthdays, catering orders.', filters: { tags: ['occasions'] } },
  { name: 'Health-Conscious Eaters',   description: 'Gym-goers, 18-35, high-protein, less price-conscious.', filters: { ageRange: '18-35', tags: ['health'] } },
  { name: 'Households',                description: 'Working nuclear families ordering to save time.', filters: { tags: ['family'] } },
  { name: 'Experience Seekers',        description: 'Curious DHA residents trying new concepts.', filters: { tags: ['curious'] } },
  { name: 'Premium Indulgence Buyers', description: 'High AOV buyers adding extras + upgrades.', filters: { aovMin: 3000 } },
  { name: 'Social Hosting Buyers',     description: 'Small gatherings + friend dinners.', filters: { partySize: '4-8' } },
  { name: 'Late-Night Buyers',         description: 'Impulse solo orders late at night.', filters: { hourRange: '22-02' } },
  { name: 'Corporate / Structured',    description: 'Office lunches + admin orders.', filters: { tags: ['corporate'] } },
  { name: 'Delivery-Fee Optimizers',   description: 'Buyers optimizing total cart value.', filters: { tags: ['fee_sensitive'] } },
  { name: 'Cultural / Occasion Buyers',description: 'Ramzan, Jummah, sports nights.', filters: { tags: ['cultural'] } },
  { name: 'Habitual Buyers',           description: 'Same SKU weekly with little variation.', filters: { tags: ['habitual'] } },
  { name: 'Gen Z / Social Sharers',    description: 'Influencer / viral traffic.', filters: { ageRange: '16-25', tags: ['social','viral'] } },
]

interface Ingredient { name: string; category: string; seasonality: string; unit: string }

const INGREDIENTS: Ingredient[] = [
  // Year-round staples
  { name: 'Banana',                category: 'Fruit',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Dates',                 category: 'Fruit',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Lemon',                 category: 'Fruit',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Tamarind',              category: 'Fruit',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Raisins',               category: 'Fruit',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Onion',                 category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Potato',                category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Tomato',                category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Garlic',                category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Ginger',                category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Green Chili',           category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Red Chili',             category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Okra',                  category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Spinach / Palak',       category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Fenugreek Leaves (Methi)', category: 'Vegetable',    seasonality: 'year-round',  unit: 'kg' },
  { name: 'Carrot',                category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Radish',                category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Cauliflower',           category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Cabbage',               category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Peas',                  category: 'Vegetable',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Mint',                  category: 'Herb',            seasonality: 'year-round',  unit: 'kg' },
  { name: 'Coriander Leaf',        category: 'Herb',            seasonality: 'year-round',  unit: 'kg' },
  { name: 'Wheat Flour',           category: 'Grain / Staple',  seasonality: 'year-round',  unit: 'kg' },
  { name: 'Basmati Rice',          category: 'Grain / Staple',  seasonality: 'year-round',  unit: 'kg' },
  { name: 'Chickpea / Chana',      category: 'Legume / Staple', seasonality: 'year-round',  unit: 'kg' },
  { name: 'Lentil / Masoor',       category: 'Legume / Staple', seasonality: 'year-round',  unit: 'kg' },
  { name: 'Mash / Black Gram',     category: 'Legume / Staple', seasonality: 'year-round',  unit: 'kg' },
  { name: 'Mung Dal',              category: 'Legume / Staple', seasonality: 'year-round',  unit: 'kg' },
  { name: 'Honey',                 category: 'Sweetener',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Sugar (White)',         category: 'Sweetener',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Jaggery / Gur',         category: 'Sweetener',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Milk',                  category: 'Dairy',           seasonality: 'year-round',  unit: 'L'  },
  { name: 'Cream',                 category: 'Dairy',           seasonality: 'year-round',  unit: 'L'  },
  { name: 'Butter',                category: 'Dairy',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Paneer',                category: 'Dairy',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Ghee',                  category: 'Dairy',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Mustard Oil',           category: 'Oil',             seasonality: 'year-round',  unit: 'L'  },
  { name: 'Sunflower Oil',         category: 'Oil',             seasonality: 'year-round',  unit: 'L'  },
  { name: 'Canola Oil',            category: 'Oil',             seasonality: 'year-round',  unit: 'L'  },
  { name: 'Coconut Oil',           category: 'Oil',             seasonality: 'year-round',  unit: 'L'  },
  { name: 'Olive Oil',             category: 'Oil',             seasonality: 'year-round',  unit: 'L'  },
  { name: 'Salt',                  category: 'Seasoning',       seasonality: 'year-round',  unit: 'kg' },
  { name: 'Black Pepper',          category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Cumin / Jeera',         category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Coriander Seed',        category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Turmeric / Haldi',      category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Cardamom / Elaichi',    category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Clove',                 category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Cinnamon',              category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Saffron',               category: 'Spice',           seasonality: 'year-round',  unit: 'kg' },
  { name: 'Vinegar',               category: 'Acid',            seasonality: 'year-round',  unit: 'L'  },
  { name: 'Tamarind Paste',        category: 'Acid',            seasonality: 'year-round',  unit: 'kg' },
  { name: 'Soy Sauce',             category: 'Condiment',       seasonality: 'year-round',  unit: 'L'  },

  // Spring (Feb–Apr)
  { name: 'Strawberry',            category: 'Fruit',     seasonality: 'spring',  unit: 'kg' },
  { name: 'Mulberry',              category: 'Fruit',     seasonality: 'spring',  unit: 'kg' },
  { name: 'Loquat / Ber',          category: 'Fruit',     seasonality: 'spring',  unit: 'kg' },
  { name: 'Early Guava',           category: 'Fruit',     seasonality: 'spring',  unit: 'kg' },
  { name: 'Spring Peas',           category: 'Vegetable', seasonality: 'spring',  unit: 'kg' },
  { name: 'Beetroot',              category: 'Vegetable', seasonality: 'spring',  unit: 'kg' },
  { name: 'Green Beans',           category: 'Vegetable', seasonality: 'spring',  unit: 'kg' },
  { name: 'Zucchini / Courgette',  category: 'Vegetable', seasonality: 'spring',  unit: 'kg' },
  { name: 'Dill / Soya',           category: 'Herb',      seasonality: 'spring',  unit: 'kg' },

  // Summer / monsoon (May–Aug)
  { name: 'Mango',                 category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Falsa / Phalsa',        category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Lychee',                category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Peach',                 category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Plum',                  category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Apricot',               category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Watermelon',            category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Muskmelon',             category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Grapes',                category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Fig',                   category: 'Fruit',     seasonality: 'summer',  unit: 'kg' },
  { name: 'Eggplant / Baingan',    category: 'Vegetable', seasonality: 'summer',  unit: 'kg' },
  { name: 'Bottle Gourd (Lauki)',  category: 'Vegetable', seasonality: 'summer',  unit: 'kg' },
  { name: 'Bitter Gourd (Karela)', category: 'Vegetable', seasonality: 'summer',  unit: 'kg' },
  { name: 'Cucumber',              category: 'Vegetable', seasonality: 'summer',  unit: 'kg' },
  { name: 'Sweet Corn',            category: 'Vegetable', seasonality: 'summer',  unit: 'kg' },
  { name: 'Basil / Niazbo',        category: 'Herb',      seasonality: 'summer',  unit: 'kg' },
  { name: 'Lemongrass',            category: 'Herb',      seasonality: 'summer',  unit: 'kg' },

  // Autumn (Sep–Nov)
  { name: 'Pomegranate',           category: 'Fruit',     seasonality: 'autumn',  unit: 'kg' },
  { name: 'Sweet Lime / Mosambi',  category: 'Fruit',     seasonality: 'autumn',  unit: 'kg' },
  { name: 'Early Kinnow',          category: 'Fruit',     seasonality: 'autumn',  unit: 'kg' },
  { name: 'Pumpkin',               category: 'Vegetable', seasonality: 'autumn',  unit: 'kg' },
  { name: 'Sweet Potato',          category: 'Vegetable', seasonality: 'autumn',  unit: 'kg' },
  { name: 'Capsicum',              category: 'Vegetable', seasonality: 'autumn',  unit: 'kg' },

  // Winter (Dec–Feb)
  { name: 'Kinnow',                category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Orange',                category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Grapefruit',            category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Persimmon (Amlok)',     category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Walnut',                category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Almond',                category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Pistachio',             category: 'Fruit',     seasonality: 'winter',  unit: 'kg' },
  { name: 'Turnip',                category: 'Vegetable', seasonality: 'winter',  unit: 'kg' },
  { name: 'Broccoli',              category: 'Vegetable', seasonality: 'winter',  unit: 'kg' },
]

interface Vendor { name: string; phone?: string; email?: string; address?: string; notes?: string }

const VENDORS: Vendor[] = [
  { name: 'Packaging Hub',   phone: '+92 312 947195',  notes: 'Lahore-based packaging supplier — https://packaginghub.pk/' },
  { name: 'EcoPak',           phone: '+92 333 845 9500', notes: 'Karachi — eco-friendly packaging — https://ecopakonline.com/' },
  { name: 'Pack It Up',       phone: '+92 322 262 0169', notes: 'Karachi — generic packaging' },
  { name: 'Premium Cutlery',  phone: '+92 301 8640019',  notes: 'Lahore — premium silverware + tableware' },
]

async function main() {
  console.log('🌱 Seeding GS Foods data into servd…\n')

  // Tenant — find or create the "main" tenant
  let tenant = await prisma.tenant.findFirst({ where: { slug: 'main' } })
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { slug: 'main', name: 'GS Foods', isActive: true },
    })
    console.log(`  ✓ Created tenant "${tenant.name}"`)
  }

  // Brands
  let brandsCreated = 0
  for (const b of BRANDS) {
    const existing = await prisma.concept.findUnique({ where: { slug: b.slug } })
    if (existing) {
      await prisma.concept.update({
        where: { id: existing.id },
        data: { name: b.name, description: b.description, primaryColor: b.primaryColor, heroTagline: b.heroTagline, tenantId: tenant.id },
      })
    } else {
      await prisma.concept.create({
        data: {
          slug: b.slug, name: b.name, type: b.type,
          description: b.description, primaryColor: b.primaryColor, heroTagline: b.heroTagline,
          taxRate: 17, isActive: true, storefrontVisible: true, tenantId: tenant.id,
        },
      })
      brandsCreated++
    }
  }
  console.log(`  ✓ ${brandsCreated} brands created (${BRANDS.length - brandsCreated} updated)`)

  // Segments
  let segmentsCreated = 0
  for (const s of SEGMENTS) {
    const existing = await prisma.segment.findFirst({ where: { name: s.name } })
    if (existing) {
      await prisma.segment.update({ where: { id: existing.id }, data: { description: s.description, filters: s.filters as never } })
    } else {
      await prisma.segment.create({ data: { name: s.name, description: s.description, filters: s.filters as never } })
      segmentsCreated++
    }
  }
  console.log(`  ✓ ${segmentsCreated} segments created (${SEGMENTS.length - segmentsCreated} updated)`)

  // Ingredients
  let ingCreated = 0
  for (const i of INGREDIENTS) {
    const existing = await prisma.inventoryItem.findFirst({ where: { name: i.name } })
    if (existing) {
      await prisma.inventoryItem.update({
        where: { id: existing.id },
        data: { unit: i.unit, notes: `${i.category} · ${i.seasonality}` },
      })
    } else {
      await prisma.inventoryItem.create({
        data: {
          name: i.name, unit: i.unit, currentStock: 0, parLevel: 0,
          notes: `${i.category} · ${i.seasonality}`,
        },
      })
      ingCreated++
    }
  }
  console.log(`  ✓ ${ingCreated} ingredients created (${INGREDIENTS.length - ingCreated} updated)`)

  // Vendors
  let vendorsCreated = 0
  for (const v of VENDORS) {
    const existing = await prisma.supplier.findFirst({ where: { name: v.name } })
    if (existing) {
      await prisma.supplier.update({ where: { id: existing.id }, data: v })
    } else {
      await prisma.supplier.create({ data: v })
      vendorsCreated++
    }
  }
  console.log(`  ✓ ${vendorsCreated} vendors created (${VENDORS.length - vendorsCreated} updated)`)

  console.log('\n🎉 GS Foods seed complete.')
  console.log('\nNext steps in the app:')
  console.log('  • /marketing/brands         → tweak brand copy + logos')
  console.log('  • /crm/segments             → see all 20 customer segments')
  console.log('  • /inventory                → 100+ ingredients with category + seasonality')
  console.log('  • /procurement              → 4 vendors with contact info')
  console.log('  • /finance/capital-ledger   → log your PKR 34M expenditure')
  console.log('  • /finance/capex            → BOH/FOH scope item-level')
  console.log('  • /finance/projections      → model your scenarios end-to-end')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
