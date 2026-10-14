# recipes

Backend module: **recipes**. HTTP routes + business logic for the Recipes domain. Registered into Fastify by `src/index.ts` under the `/recipes` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module

## Kinds

- **plate** — a dish, 1:1 with a menu item (or a deferred `pendingMenuItem` while testing).
- **component** — a sub-recipe, costed per gram of its batch yield.
- **modifier** — an add-on: what ONE unit of a menu modifier uses (`modifierId`, no menu item). One recipe per
  modifier (409 `MODIFIER_HAS_RECIPE`). Its company is modifier → group → menu item → brand; the chain must be in
  the operator's CREATE scope (another company's add-on 404, another of their own companies 422
  `MODIFIER_NOT_IN_COMPANY`). Only modifier recipes may have a NEGATIVE quantity ("removes", e.g. "No onion");
  the sale clamps each ingredient at zero per line.

## Sections and the packaging rule (owner's FINAL rule, 2026-10-13)

Every plate recipe has an optional **Packaging** section (`RecipeIngredient.section = 'packaging'`), whatever the
brand. Whether a SALE uses it is decided at the sale by `lib/recipeCost.ts packagingApplies` — never per line here:
takeaway / delivery → yes; a brand whose primary service vessel is `'packaging'` (Concept.serviceVessel, e.g.
Stackd) → yes on every order; dine-in at a plate brand → only when staff tap "Box given". A recipe needs no
packaging to be approved; a packaging-vessel brand's dish with none gets the warning `PACKAGING_MISSING` (save,
submit, approve, preview) — never a block. `packagingPct` is retired: ignored if sent, never written.

THE line rules (`validateRecipeLines`, used by create, PUT and costing-preview), all 422:

| Code | When |
|---|---|
| `PACKAGING_SECTION_ONLY` | a packaging-class item (`costClassOf(category) === 'packaging'`) under Ingredients of a plate |
| `NOT_PACKAGING` | food, drinks or a sub-recipe under Packaging |
| `PACKAGING_ON_PLATES_ONLY` | a Packaging section, or a packaging-class item, on a sub-recipe or add-on |
| `ITEM_NOT_IN_COMPANY` | stock of another company than the recipe's (plate → its brand's; add-on → its chain's) |
| `ITEM_HAS_NO_COMPANY` | company-less stock (a sale never consumes it) |
| `NEGATIVE_QTY_NOT_ALLOWED` | a negative quantity on anything but an add-on |
| `INGREDIENT_NOT_IN_COMPANY` | a sub-recipe the operator cannot see |

Only NEW or CHANGED lines are refused: a line already on the recipe (same item or sub-recipe, same section — e.g. a
packaging item the wave-B backfill left in a sub-recipe) passes with its code as a warning in `warnings`.

## Costing fields (lib/recipeCost.ts `RecipeCost`, per portion, whole paisa)

`GET /recipes/:id/costing`, `POST /recipes/costing-preview` and each `GET /recipes` row (`mc`) carry:

- `stockByClass { food, beverage, packaging }` — everything the dish can consume, ex-Q.
- `packagingCents` — the Packaging section alone.
- `standardCents` — the **plate MC** (food + drinks). `cost.plateCostCents` = this.
- `targetMcCents { dine_in, takeout, delivery }` — plate MC + packaging where that order type uses it for the brand's
  vessel (takeaway / delivery always; dine-in only at a packaging brand). A dine-in "Box given" is an actual.
- `qCents` — the Q factor allowance (`Recipe.qFactorPct`, the ONE pricing allowance: plate wear, garnish, oil; H18) on
  the ingredient lines only. Pricing only: never stock, never posted, never inside an MC.
- `warnings { outsideCompany[], costedWhileUnapproved, noPackaging }` — stock of another company (or none) at any depth;
  a recipe not approved while its dish / add-on is on sale; a packaging-vessel brand's dish with no Packaging line.

Pricing on `/:id/costing` covers the brand's main order type's target MC (`targetMcCents.dine_in`) + Q:
break-even = MC + Q + opex; target = (MC + Q + opex) ÷ (1 − target profit %). `profitability.byOrderType` gives the
margin per order type on the real packaging lines.

`GET /recipes/by-item/:menuItemId` (KDS) returns the lines with `section`, grouped in `sections.ingredients` /
`sections.packaging` ("Pack in"), and `addOns[]` — the dish's add-on recipes with their lines.

`GET /recipes/food-cost` is gone: the food-cost report is `/reports/food-cost` (reports/foodCost.ts).
