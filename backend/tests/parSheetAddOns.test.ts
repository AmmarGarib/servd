// F6 — the par sheet lists sub-recipes reached from ADD-ON (modifier) recipes,
// not only from plates, and stays inside the company: company B's add-on
// sub-recipe is never on company A's sheet.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { subRecipeIdsForCompany } from '../src/modules/par-sheet/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string
let platePrep: string, addOnPrep: string, nestedPrep: string, deletedAddOnPrep: string, addOnPrepB: string

async function company(key: string) {
  const tenantId = (await prisma.tenant.create({ data: { name: `Par ${key}`, slug: `par-${key}-${RUN}` } })).id
  const conceptId = (await prisma.concept.create({ data: { name: `Par Brand ${key}`, slug: `par-brand-${key}-${RUN}`, type: 'restaurant', tenantId } as never })).id
  const categoryId = (await prisma.category.create({ data: { conceptId, name: 'Mains' } })).id
  const menuItemId = (await prisma.menuItem.create({ data: { conceptId, categoryId, name: 'Burger', priceCents: 100_000 } })).id
  return { tenantId, menuItemId }
}

const component = async (name: string, prepRecipeIds: string[] = []) =>
  (await prisma.recipe.create({
    data: {
      kind: 'component', name: `${name}-${RUN}`, yieldGrams: 1000,
      ingredients: { create: prepRecipeIds.map((prepRecipeId) => ({ prepRecipeId, quantity: 10, unit: 'g' })) },
    },
  })).id

async function addOn(menuItemId: string, name: string, prepRecipeId: string, opts: { modifierDeleted?: boolean } = {}) {
  const group = await prisma.modifierGroup.create({ data: { menuItemId, name: 'Extras' } })
  const mod = await prisma.modifier.create({ data: { groupId: group.id, name, priceDeltaCents: 20_000, ...(opts.modifierDeleted ? { deletedAt: new Date() } : {}) } })
  await prisma.recipe.create({
    data: { kind: 'modifier', modifierId: mod.id, ingredients: { create: [{ prepRecipeId, quantity: 30, unit: 'g' }] } },
  })
}

beforeAll(async () => {
  const A = await company('a')
  const B = await company('b')
  tenantA = A.tenantId; tenantB = B.tenantId
  platePrep = await component('patty-mix')
  nestedPrep = await component('roasted-garlic')
  addOnPrep = await component('garlic-mayo', [nestedPrep]) // used ONLY by an add-on, itself built from a sub-recipe
  deletedAddOnPrep = await component('old-sauce')
  addOnPrepB = await component('b-only-sauce')
  await prisma.recipe.create({ data: { kind: 'plate', menuItemId: A.menuItemId, ingredients: { create: [{ prepRecipeId: platePrep, quantity: 150, unit: 'g' }] } } })
  await addOn(A.menuItemId, 'Garlic mayo', addOnPrep)
  await addOn(A.menuItemId, 'Old sauce', deletedAddOnPrep, { modifierDeleted: true })
  await addOn(B.menuItemId, 'B sauce', addOnPrepB)
})

describe('par sheet sub-recipes (F6)', () => {
  it("includes sub-recipes reached only through the company's add-ons, nested ones too", async () => {
    const used = await subRecipeIdsForCompany(tenantA)
    expect(used.has(platePrep)).toBe(true)
    expect(used.has(addOnPrep)).toBe(true)
    expect(used.has(nestedPrep)).toBe(true)
  })

  it("leaves out a deleted add-on's sub-recipe and another company's add-on sub-recipe", async () => {
    const usedA = await subRecipeIdsForCompany(tenantA)
    expect(usedA.has(deletedAddOnPrep)).toBe(false)
    expect(usedA.has(addOnPrepB)).toBe(false)
    const usedB = await subRecipeIdsForCompany(tenantB)
    expect(usedB.has(addOnPrepB)).toBe(true)
    expect(usedB.has(addOnPrep)).toBe(false)
    expect(usedB.has(platePrep)).toBe(false)
  })
})
