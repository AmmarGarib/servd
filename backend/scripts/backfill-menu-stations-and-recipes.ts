// Ensures every menu item the operator already has in the DB is actually
// COOKABLE: assigned to a station, and backed by a one-step recipe so the
// fire/cascade engine has something to route. Idempotent — re-runnable
// without clobbering anything an operator has hand-tuned.
//
// What it does, in order:
//   1. For each Concept, ensure a sensible station roster exists. If the
//      concept has zero stations, seed: Prep, Grill, Fryer, Plating, Expo.
//      Existing stations are left alone.
//   2. For every MenuItem with `stationId = null`, pick a station from its
//      concept using a name-heuristic (fries → Fryer, burger → Grill, etc.)
//      and assign it. Items whose names give no signal default to Prep.
//   3. For every MenuItem with no Recipe, create one with a single
//      `service_cook` step on the item's station, instruction "Prepare,
//      plate, and call expo." Estimated 180s.
//   4. For every Recipe that has no recipeSteps, add the same one-step
//      fallback so the fire engine has something to route.
//
// Run with:
//   cd backend && npx tsx scripts/backfill-menu-stations-and-recipes.ts

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Station roster a fresh concept gets when it has none. Order matches the
// typical line layout: prep → cook → fry → plate → pass.
const DEFAULT_STATIONS = [
  { name: 'Prep',    displayOrder: 0 },
  { name: 'Grill',   displayOrder: 1 },
  { name: 'Fryer',   displayOrder: 2 },
  { name: 'Plating', displayOrder: 3 },
  { name: 'Expo',    displayOrder: 4 },
] as const

// Lightweight name-→-station heuristic. Keeps the routing legible without
// requiring the operator to think. Falls back to Prep when nothing matches.
function pickStationForItem(itemName: string, stations: Array<{ id: string; name: string }>): string | null {
  const lower = itemName.toLowerCase()
  const find = (needle: string) => stations.find((s) => s.name.toLowerCase().includes(needle))?.id ?? null

  // Fryer
  if (/(fries|fried|wings|nuggets|tempura|fritter|tots|chips|onion ring)/.test(lower)) return find('fry') ?? find('prep')
  // Grill (burgers / steak / meats / bbq / kebab / chicken cooked)
  if (/(burger|steak|smash|patty|kebab|kabab|grill|wing|chicken sandwich|chicken strip|chicken slider|salmon|sea bass|lamb|tikka|seekh|shawarma|wrap|pizza|naan|paratha)/.test(lower)) return find('grill') ?? find('prep')
  // Plating (cold / dessert / drinks / starters)
  if (/(salad|tartare|carpaccio|crudo|cocktail|mojito|lemonade|smoothie|juice|cooler|coffee|tea|brûlée|brulee|tiramisu|cheesecake|ice cream|dessert|panna cotta)/.test(lower)) return find('plat') ?? find('prep')
  // Prep / hot kitchen catch-all (risotto, soup, pasta, curry)
  if (/(risotto|pasta|soup|curry|biryani|rice|bowl|noodle|stir fry|paella)/.test(lower)) return find('prep') ?? find('grill')
  // Default: anything else lands on Prep
  return find('prep') ?? stations[0]?.id ?? null
}

async function ensureStationsForConcept(conceptId: string, conceptName: string): Promise<{ id: string; name: string }[]> {
  const existing = await prisma.station.findMany({
    where: { conceptId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { displayOrder: 'asc' },
  })
  if (existing.length > 0) return existing

  // No stations yet — seed the default roster.
  console.log(`  ${conceptName}: no stations found, seeding ${DEFAULT_STATIONS.length}…`)
  for (const tpl of DEFAULT_STATIONS) {
    await prisma.station.create({
      data: {
        conceptId,
        name: tpl.name,
        displayOrder: tpl.displayOrder,
        isActive: true,
      },
    })
  }
  return prisma.station.findMany({
    where: { conceptId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { displayOrder: 'asc' },
  })
}

async function main() {
  console.log('─── Backfill: menu stations + recipes ───────────────────────────────')

  const concepts = await prisma.concept.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true },
  })
  console.log(`Found ${concepts.length} concept${concepts.length === 1 ? '' : 's'}.`)

  let stationsAssigned = 0
  let recipesCreated   = 0
  let stepsCreated     = 0

  for (const concept of concepts) {
    console.log(`\n• ${concept.name}`)
    const stations = await ensureStationsForConcept(concept.id, concept.name)
    if (stations.length === 0) {
      console.log('  No stations could be created — skipping items.')
      continue
    }

    const items = await prisma.menuItem.findMany({
      where: { conceptId: concept.id, deletedAt: null },
      select: { id: true, name: true, stationId: true, recipe: { select: { id: true, recipeSteps: { select: { id: true } } } } },
    })
    console.log(`  ${items.length} menu items.`)

    for (const item of items) {
      // ─── Station assignment ──────────────────────────────────────────
      let stationId = item.stationId
      if (!stationId) {
        stationId = pickStationForItem(item.name, stations)
        if (stationId) {
          await prisma.menuItem.update({ where: { id: item.id }, data: { stationId } })
          stationsAssigned++
          const stName = stations.find((s) => s.id === stationId)?.name
          console.log(`    + ${item.name} → ${stName}`)
        }
      }

      // ─── Recipe + minimal step ───────────────────────────────────────
      if (!item.recipe) {
        await prisma.recipe.create({
          data: {
            menuItemId: item.id,
            servings:   1,
            notes:      'Auto-generated placeholder. Edit in /accounting/recipes.',
            steps:      'Prepare to order, plate, and call expo when ready.',
            recipeSteps: stationId ? {
              create: [{
                phase:            'service_cook',
                ordinal:          0,
                stationId,
                instruction:      `Prepare ${item.name}, plate, and call expo when ready.`,
                estimatedSeconds: 180,
                dependsOnIds:     [],
              }],
            } : undefined,
          },
        })
        recipesCreated++
        if (stationId) stepsCreated++
      } else if (item.recipe.recipeSteps.length === 0 && stationId) {
        await prisma.recipeStep.create({
          data: {
            recipeId:         item.recipe.id,
            phase:            'service_cook',
            ordinal:          0,
            stationId,
            instruction:      `Prepare ${item.name}, plate, and call expo when ready.`,
            estimatedSeconds: 180,
            dependsOnIds:     [],
          },
        })
        stepsCreated++
      }
    }
  }

  console.log('\n─── Summary ─────────────────────────────────────────────────────────')
  console.log(`Stations assigned to items: ${stationsAssigned}`)
  console.log(`Recipes created:            ${recipesCreated}`)
  console.log(`Recipe steps created:       ${stepsCreated}`)
  console.log('Done. New orders fired from /expo will now route to a station.')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
