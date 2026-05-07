// Seed the component matrix captured in the GS Foods PDF.
// One row per ingredient → hero / supporting / trim_waste components.
// Idempotent: skips components that already exist (by name + ingredient pair).

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface Spec {
  ingredient: string                   // matches InventoryItem.name (case-insensitive)
  hero?: string[]
  supporting?: string[]
  trim?: string[]
  seasons?: string[]                   // applies to all components in this row unless overridden
}

// Mirrors the columns from the operator's Excel: Hero / Supporting / Trim-Waste
// for each base ingredient. Add seasonal variants by inserting more entries —
// the components UI lets you tag any component to one or many seasons.
const MATRIX: Spec[] = [
  { ingredient: 'Banana',  hero: ['Banana Pudding'] },
  { ingredient: 'Dates',
    hero: ['Stuffed Dates'],
    supporting: ['Date Syrup', 'Date Ketchup'],
    trim: ['Date Coffee'] },
  { ingredient: 'Lemon',
    hero: ['Lemon Curd / Fluid Gel'],
    supporting: ['Preserved Lemons'],
    trim: ['Candied Lemon Julienne'] },
  { ingredient: 'Tamarind',
    hero: ['Tamarind Ketchup'],
    supporting: ['Tamarind Mocktail Base'] },
  { ingredient: 'Raisins',
    hero: ['Raisin Mocktail Base'],
    supporting: ['Raisin Cake'] },
  { ingredient: 'Onion',
    hero: ['Caramelised Onion (Base)'],
    supporting: ['Pickled Onions', 'Carmy Jam', 'Fried Onion'],
    trim: ['Chopped Tomato-Onion Salsa'] },
  { ingredient: 'Potato',
    hero: ['Layered Fries (Pommes)'],
    supporting: ['Hand-cut Fries'],
    trim: ['Roasties'] },
  { ingredient: 'Tomato',
    hero: ['Compressed Tomato Panzanella'],
    supporting: ['Marinara'],
    trim: ['Chopped Tomato-Onion Salsa'] },
  { ingredient: 'Garlic',
    hero: ['Confit Garlic Aioli (Toum)'],
    supporting: ['Minced Garlic Cubes'],
    trim: ['Garlic-Chilli Oil'] },
  { ingredient: 'Ginger',
    hero: ['Ginger Mocktail Base'],
    supporting: ['Ginger-Scallion Sauce (Hainanese)'],
    trim: ['Ginger Chilli Oil'] },
  { ingredient: 'Green Chili',
    hero: ['Masala Stuffed Pepper (Abida Dadi)'],
    supporting: ['Chilli Flakes'],
    trim: ['Chilli Oil from trim'] },
  { ingredient: 'Red Chili',
    hero: ['Fermented Hot Sauce'],
    supporting: ['Chilli Flakes'],
    trim: ['Chilli Oil from trim'] },
  { ingredient: 'Okra',
    hero: ['Okra Fries'],
    supporting: ['Okra Shoestrings'] },
  // Amaranth — not seeded in main ingredient list, will create on the fly
  { ingredient: 'Amaranth / Chaulai',
    hero: ['Amaranth Protein Bar'],
    supporting: ['Amaranth Cracker'] },
  { ingredient: 'Spinach / Palak',
    hero: ['Batter-Fried Spinach'],
    supporting: ['Saag'] },
  { ingredient: 'Fenugreek Leaves (Methi)',
    hero: ['Methi Paratha Rolls'],
    supporting: ['Methi Oil'] },
  // Kohlrabi — also not in main list
  { ingredient: 'Kohlrabi / Knol Khol',
    hero: ['Raw Kohlrabi Slaw'],
    supporting: ['Pickled Kohlrabi Melon-balls'] },
  { ingredient: 'Arbi / Taro Root',
    hero: ['Taro Chips'],
    supporting: ['Taro Mash', 'Taro Croquettes'] },
  { ingredient: 'Radish',
    hero: ['Pickled Radish'] },
]

async function main() {
  console.log('🌱 Seeding GS Foods component library…\n')

  // Build a map of ingredient name → id (case-insensitive)
  const allIngredients = await prisma.inventoryItem.findMany({ where: { deletedAt: null } })
  const byName = new Map(allIngredients.map((i) => [i.name.toLowerCase(), i]))

  let created = 0
  let skipped = 0
  let ingredientsCreated = 0

  for (const spec of MATRIX) {
    // Resolve or create the base ingredient
    let ingredient = byName.get(spec.ingredient.toLowerCase())
    if (!ingredient) {
      ingredient = await prisma.inventoryItem.create({
        data: { name: spec.ingredient, unit: 'kg', currentStock: 0, parLevel: 0, notes: 'Vegetable · year-round' },
      })
      byName.set(spec.ingredient.toLowerCase(), ingredient)
      ingredientsCreated++
    }

    const buckets: Array<['hero' | 'supporting' | 'trim_waste', string[] | undefined]> = [
      ['hero', spec.hero],
      ['supporting', spec.supporting],
      ['trim_waste', spec.trim],
    ]

    for (const [type, names] of buckets) {
      if (!names) continue
      for (const name of names) {
        const existing = await prisma.component.findFirst({
          where: { name, baseIngredientId: ingredient.id, deletedAt: null },
        })
        if (existing) { skipped++; continue }
        await prisma.component.create({
          data: {
            name,
            type,
            baseIngredientId: ingredient.id,
            seasons: spec.seasons ?? [],
            isActive: true,
          },
        })
        created++
      }
    }
  }

  console.log(`  ✓ ${created} components created (${skipped} already existed)`)
  if (ingredientsCreated > 0) console.log(`  ✓ ${ingredientsCreated} ingredients added on the fly`)
  console.log('\n🎉 Component library seeded.')
  console.log('   Open /components in the admin to browse + tag seasons + add brand uses.')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
