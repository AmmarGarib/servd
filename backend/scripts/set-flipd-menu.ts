// Replace flipd's menu with the real one from the brand's menu spec sheet.
//
// What was in the DB before this ran was placeholder data invented during the
// first build of the concept — "The Court Classic", "Bacon Smash", "Smash
// Sauce Wings", "Mango Lassi Shake". None of it is on flipd's sheet, and one
// of them (bacon) isn't something the kitchen serves at all. This script is
// the correction.
//
// Item names and build lines are VERBATIM from the sheet. The brand book's
// voice rule is "plain-spoken: names the ingredient, skips the adjective" and
// its first core value is "the spec is the boss", so the build line IS the
// description and nothing is written around it.
//
// Idempotent: run it as many times as you like. It matches on (category name,
// item name) and updates in place, so prices edited in admin are overwritten
// by whatever is in PRICES below — that is the point, it's an import, not a
// merge. Items that exist in the DB but not on the sheet are soft-deleted
// (deletedAt), never hard-deleted, because historical order rows point at them.
//
//   npx tsx scripts/set-flipd-menu.ts            # dry run, prints the plan
//   npx tsx scripts/set-flipd-menu.ts --apply    # writes

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

// ─────────────────────────────────────────────────────────────────────────────
// PRICES — the only thing here that did not come off the sheet.
//
// The menu sheet carries builds and options, not money, so these are set from
// the operator's price list. Everything is in PAISA (PKR * 100), matching the
// rest of the system: 1200_00 is PKR 1,200.
//
// A null price means "not priced yet". The script refuses to publish a null
// item — it creates it as isAvailable: false and says so — so a half-filled
// table can never put an unpriced item in front of a customer.
// ─────────────────────────────────────────────────────────────────────────────
type Paisa = number | null

const PRICES: Record<string, Paisa> = {
  // Burgers · Smashed  (base price = Single)
  'Chimi Shimi': null,
  'Garlic Shroom': null,
  'Sweet Chili Shroom': null,
  // Burgers · Grilled
  'Chili Jam Chicken': null,
  'Pub Classic': null,
  'Pub Shroom': null,
  // Sides · Fried
  'Chili Jam Tenders': null,
  'Buffalo Tenders': null,
  'Masala Tenders': null,
  // Sides · Taters
  'Handcut Fries': null,
  'Curly Fries': null,
  'Roasted Potatoes': null,
  // Drinks
  'Wild Berry': null,
  'Pineapple': null,
  'Lemon & Lime': null,
  'Orange': null,
  'Strawberry Limeade': null,
  // Flip Side
  'Salted Chocolate Mousse': null,
  'Brownie & Ice Cream': null,
  'Cookie & Ice Cream': null,
}

// Per-option price deltas, in paisa. 0 means the option costs nothing extra.
// Keyed by the option's own name so one entry covers every item that offers it.
const OPTION_DELTAS: Record<string, Paisa> = {
  // Burger sizes. Single is the base (0). Double needs the second patty's
  // price; lettuce wrap is usually level with single but say so explicitly.
  'Single': 0,
  'Double': null,
  'Lettuce wrap': 0,
  // Tenders: served in a brioche or tossed loose. Same food either way.
  'Brioched': 0,
  'Tossed': 0,
  // Tater dressings — all included.
  'Masala': 0,
  'Salt n pepper': 0,
  'Roasted garlic aioli': 0,
  'Chimichurri aioli': 0,
  // Drinks base. Coconut water typically costs more than still or sparkling.
  'Still': 0,
  'Sparkling': 0,
  'Coconut': null,
  // Flip Side toppings — all included.
  'Chocolate': 0,
  'Salted caramel': 0,
  'Brown butter crumble': 0,
  'Cookie crumble': 0,
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MENU — verbatim from the sheet.
//
// Categories are the sheet's sections rather than its four page headings.
// "Burgers" alone would hide the smashed/grilled split, which the brand treats
// as a real distinction (it is the first thing in its own highlights), and
// "Smashed" alone reads as nothing on an ordering screen. "Burgers · Smashed"
// keeps both and sorts next to its sibling.
// ─────────────────────────────────────────────────────────────────────────────
interface Item {
  name: string
  build: string
  /** Modifier group name → the options in it. One group per item, as the sheet has it. */
  options?: { group: string; choices: string[] }
}
interface Category {
  name: string
  items: Item[]
}

const SIZE = { group: 'Size', choices: ['Single', 'Double', 'Lettuce wrap'] }
const SERVE = { group: 'Serve it', choices: ['Brioched', 'Tossed'] }
const DRESS = { group: 'Dressed', choices: ['Masala', 'Salt n pepper', 'Roasted garlic aioli', 'Chimichurri aioli'] }
const WATER = { group: 'Base', choices: ['Still', 'Sparkling', 'Coconut'] }
const SWEET = { group: 'Topping', choices: ['Chocolate', 'Salted caramel', 'Brown butter crumble', 'Cookie crumble'] }

const MENU: Category[] = [
  {
    name: 'Burgers · Smashed',
    items: [
      { name: 'Chimi Shimi',        build: 'Brioche, smash patty, chimichurri aioli, American cheese', options: SIZE },
      { name: 'Garlic Shroom',      build: 'Brioche, smash patty, shroom & onion jam, roasted garlic aioli, American cheese', options: SIZE },
      { name: 'Sweet Chili Shroom', build: 'Brioche, smash patty, house made chili jam, shroom & onion jam, American cheese', options: SIZE },
    ],
  },
  {
    name: 'Burgers · Grilled',
    items: [
      { name: 'Chili Jam Chicken', build: 'Brioche, grilled chicken breast, house made chili jam', options: SIZE },
      { name: 'Pub Classic',       build: 'Brioche, 6oz grilled beef patty, ketchup, mustard, pickles, American cheese', options: SIZE },
      { name: 'Pub Shroom',        build: 'Brioche, 6oz grilled beef patty, shroom & onion jam, house made chili jam', options: SIZE },
    ],
  },
  {
    name: 'Sides · Fried',
    items: [
      { name: 'Chili Jam Tenders', build: 'Brined and fried tenders, house made chili jam, roasted garlic aioli', options: SERVE },
      { name: 'Buffalo Tenders',   build: 'Brined and fried tenders, buffalo sauce, roasted garlic aioli',        options: SERVE },
      { name: 'Masala Tenders',    build: 'Brined and fried tenders, house masala, chimichurri aioli',            options: SERVE },
    ],
  },
  {
    name: 'Sides · Taters',
    items: [
      { name: 'Handcut Fries',    build: 'Hand cut. Triple cooked.',                          options: DRESS },
      { name: 'Curly Fries',      build: 'Twisty. Crispy.',                                   options: DRESS },
      { name: 'Roasted Potatoes', build: 'Smashd. Roasted. Dressed with rustic chimichurri.', options: DRESS },
    ],
  },
  {
    name: 'Drinks',
    items: [
      { name: 'Wild Berry',         build: 'Electrolytes', options: WATER },
      { name: 'Pineapple',          build: 'Electrolytes', options: WATER },
      { name: 'Lemon & Lime',       build: 'Electrolytes', options: WATER },
      { name: 'Orange',             build: 'Electrolytes', options: WATER },
      { name: 'Strawberry Limeade', build: 'Electrolytes', options: WATER },
    ],
  },
  {
    name: 'Flip Side',
    items: [
      { name: 'Salted Chocolate Mousse', build: 'Chocolate mousse',                         options: SWEET },
      { name: 'Brownie & Ice Cream',     build: 'Brownie, vanilla ice cream',               options: SWEET },
      { name: 'Cookie & Ice Cream',      build: 'Chocolate chip cookie, vanilla ice cream', options: SWEET },
    ],
  },
]

async function main() {
  const concept = await prisma.concept.findFirst({
    where: { slug: 'flipd', deletedAt: null },
    select: { id: true, name: true, tenantId: true },
  })
  if (!concept) throw new Error('No concept with slug "flipd" — nothing to import into.')

  const unpriced = Object.entries(PRICES).filter(([, p]) => p === null).map(([n]) => n)
  const unpricedOptions = Object.entries(OPTION_DELTAS).filter(([, p]) => p === null).map(([n]) => n)

  console.log(`concept   ${concept.name} (${concept.id})`)
  console.log(`mode      ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing will be written'}`)
  console.log(`menu      ${MENU.length} categories, ${MENU.reduce((n, c) => n + c.items.length, 0)} items`)
  if (unpriced.length) {
    console.log(`\n!! ${unpriced.length} items have no price and will be created UNAVAILABLE:`)
    for (const n of unpriced) console.log(`     ${n}`)
  }
  if (unpricedOptions.length) {
    console.log(`\n!! ${unpricedOptions.length} options have no price delta and will be SKIPPED:`)
    for (const n of unpricedOptions) console.log(`     ${n}`)
  }
  console.log()

  if (!APPLY) {
    for (const cat of MENU) {
      console.log(`[${cat.name}]`)
      for (const it of cat.items) {
        const p = PRICES[it.name]
        console.log(`   ${it.name.padEnd(26)} ${p === null ? '(no price)' : `PKR ${(p / 100).toFixed(0)}`}  ${it.build}`)
      }
    }
    console.log('\nRe-run with --apply to write.')
    await prisma.$disconnect()
    return
  }

  const keptCategoryIds: string[] = []
  const keptItemIds: string[] = []

  for (const [ci, cat] of MENU.entries()) {
    let category = await prisma.category.findFirst({
      where: { conceptId: concept.id, name: cat.name, deletedAt: null },
      select: { id: true },
    })
    if (!category) {
      category = await prisma.category.create({
        data: { conceptId: concept.id, name: cat.name, displayOrder: ci },
        select: { id: true },
      })
      console.log(`+ category  ${cat.name}`)
    } else {
      await prisma.category.update({ where: { id: category.id }, data: { displayOrder: ci } })
      console.log(`= category  ${cat.name}`)
    }
    keptCategoryIds.push(category.id)

    for (const [ii, it] of cat.items.entries()) {
      const price = PRICES[it.name]
      const priceCents = price ?? 0
      // Unpriced items go in hidden. They exist so the structure is complete
      // and so filling the price in admin is a one-field job, but a PKR 0 item
      // must never be orderable.
      const isAvailable = price !== null

      let item = await prisma.menuItem.findFirst({
        where: { conceptId: concept.id, name: it.name, deletedAt: null },
        select: { id: true },
      })
      if (!item) {
        item = await prisma.menuItem.create({
          data: {
            conceptId: concept.id,
            categoryId: category.id,
            name: it.name,
            description: it.build,
            priceCents,
            isAvailable,
            displayOrder: ii,
          },
          select: { id: true },
        })
        console.log(`  + item    ${it.name}${isAvailable ? '' : '  (hidden — no price)'}`)
      } else {
        await prisma.menuItem.update({
          where: { id: item.id },
          data: {
            categoryId: category.id,
            description: it.build,
            priceCents,
            isAvailable,
            displayOrder: ii,
          },
        })
        console.log(`  = item    ${it.name}${isAvailable ? '' : '  (hidden — no price)'}`)
      }
      keptItemIds.push(item.id)

      if (!it.options) continue

      // One modifier group per item. Required + exactly one choice, because
      // every group on this sheet is a "pick how you want it", not an add-on.
      let group = await prisma.modifierGroup.findFirst({
        where: { menuItemId: item.id, name: it.options.group, deletedAt: null },
        select: { id: true },
      })
      if (!group) {
        group = await prisma.modifierGroup.create({
          data: { menuItemId: item.id, name: it.options.group, minSelect: 1, maxSelect: 1, isRequired: true, sortOrder: 0 },
          select: { id: true },
        })
      } else {
        await prisma.modifierGroup.update({
          where: { id: group.id },
          data: { minSelect: 1, maxSelect: 1, isRequired: true },
        })
      }

      const keptModifierIds: string[] = []
      for (const [oi, choice] of it.options.choices.entries()) {
        const delta = OPTION_DELTAS[choice]
        if (delta === null || delta === undefined) {
          // No delta known — leave the option off rather than guess it's free.
          // A "Double" silently priced at +0 is a burger given away.
          console.log(`    ! skip  ${choice} — no price delta`)
          continue
        }
        const existing = await prisma.modifier.findFirst({
          where: { groupId: group.id, name: choice, deletedAt: null },
          select: { id: true },
        })
        if (existing) {
          await prisma.modifier.update({
            where: { id: existing.id },
            data: { priceDeltaCents: delta, isDefault: oi === 0, sortOrder: oi },
          })
          keptModifierIds.push(existing.id)
        } else {
          const created = await prisma.modifier.create({
            data: { groupId: group.id, name: choice, priceDeltaCents: delta, isDefault: oi === 0, sortOrder: oi },
            select: { id: true },
          })
          keptModifierIds.push(created.id)
        }
      }

      // Retire modifiers that are no longer on the sheet.
      const staleMods = await prisma.modifier.updateMany({
        where: { groupId: group.id, deletedAt: null, id: { notIn: keptModifierIds.length ? keptModifierIds : ['-'] } },
        data: { deletedAt: new Date() },
      })
      if (staleMods.count) console.log(`    - retired ${staleMods.count} old option(s)`)
    }
  }

  // Retire everything that isn't on the sheet. Soft delete only — order rows
  // reference these, and a hard delete would orphan history.
  const staleItems = await prisma.menuItem.updateMany({
    where: { conceptId: concept.id, deletedAt: null, id: { notIn: keptItemIds } },
    data: { deletedAt: new Date(), isAvailable: false },
  })
  const staleCats = await prisma.category.updateMany({
    where: { conceptId: concept.id, deletedAt: null, id: { notIn: keptCategoryIds } },
    data: { deletedAt: new Date() },
  })
  console.log(`\nretired   ${staleItems.count} old item(s), ${staleCats.count} old category(ies)`)
  console.log('done.')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
