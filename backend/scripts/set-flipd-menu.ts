// Replace flipd's menu with the real one from the brand's menu spec sheet.
//
// What was in the DB before this ran was placeholder data invented during the
// first build of the concept — "The Court Classic", "Bacon Smash", "Smash
// Sauce Wings", "Mango Lassi Shake". None of it is on flipd's sheet, and one
// of them (bacon) isn't something the kitchen serves at all. This script is
// the correction.
//
// It talks to the HTTP API rather than Prisma, so it runs from anywhere with
// network access to the API — not just from the database host — and every
// write goes through the same tenant-scoping and role checks the admin UI
// uses. Nothing here can touch another company's menu.
//
// Item names and build lines are VERBATIM from the sheet. The brand book's
// voice rule is "plain-spoken: names the ingredient, skips the adjective" and
// its first core value is "the spec is the boss", so the build line IS the
// description and nothing is written around it.
//
// Idempotent: it matches on name and updates in place, so running it twice is
// the same as running it once. Items and categories in the DB that are not on
// the sheet are deleted through the API, which soft-deletes — historical order
// rows keep pointing at them.
//
//   SERVD_EMAIL=you@gsfoods.pk SERVD_PASSWORD=... npx tsx scripts/set-flipd-menu.ts
//   ...same, plus --apply, to actually write.
//
// Credentials come from the environment. Never put them in this file.

const API = process.env.SERVD_API_URL ?? 'https://servd-api.garibsons.app'
const EMAIL = process.env.SERVD_EMAIL
const PASSWORD = process.env.SERVD_PASSWORD
const APPLY = process.argv.includes('--apply')

// ─────────────────────────────────────────────────────────────────────────────
// PRICES — the only thing here that did not come off the sheet.
//
// The sheet carries builds and options, not money. Everything is in PAISA
// (PKR * 100) to match the rest of the system: 120000 is PKR 1,200.
//
// null means "not priced yet". An unpriced item is created HIDDEN
// (isAvailable: false) so it can be priced in admin → Menu and switched on,
// and can never reach a customer at PKR 0 in the meantime.
// ─────────────────────────────────────────────────────────────────────────────
type Paisa = number | null

const PRICES: Record<string, Paisa> = {
  // Smashed (base price = Single)
  'Chimi Shimi': null,
  'Garlic Shroom': null,
  'Sweet Chili Shroom': null,
  // Grilled
  'Chili Jam Chicken': null,
  'Pub Classic': null,
  'Pub Shroom': null,
  // Fried
  'Chili Jam Tenders': null,
  'Buffalo Tenders': null,
  'Masala Tenders': null,
  // Taters
  'Handcut Fries': null,
  'Curly Fries': null,
  'Roasted Potatoes': null,
  // Electrolytes
  'Wild Berry': null,
  'Pineapple': null,
  'Lemon & Lime': null,
  'Orange': null,
  'Strawberry Limeade': null,
  // Sweet
  'Salted Chocolate Mousse': null,
  'Brownie & Ice Cream': null,
  'Cookie & Ice Cream': null,
}

// Per-option price deltas, in paisa, keyed by the option's own name so one
// entry covers every item offering it. A null delta means the option is left
// OFF the item rather than guessed at — a "Double" silently priced at +0 is a
// second patty given away on every order.
const OPTION_DELTAS: Record<string, Paisa> = {
  // Burger size. Single is the base.
  'Single': 0,
  'Double': null,
  'Lettuce wrap': 0,
  // Tenders: in a brioche or tossed loose. Same food either way.
  'Brioched': 0,
  'Tossed': 0,
  // Tater dressings — all included.
  'Masala': 0,
  'Salt n pepper': 0,
  'Roasted garlic aioli': 0,
  'Chimichurri aioli': 0,
  // Drink base. Coconut water normally costs more than still or sparkling.
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
// Categories are the sheet's SECTION names. The page headings above them
// (Burgers / Sides / Drinks / Flip Side) are the operator's own sectioning
// markers, not menu headings, so they are not surfaced.
// ─────────────────────────────────────────────────────────────────────────────
interface Options { group: string; choices: string[] }
interface Item { name: string; build: string; options?: Options }
interface Category { name: string; items: Item[] }

const SIZE:  Options = { group: 'Size',       choices: ['Single', 'Double', 'Lettuce wrap'] }
const SERVE: Options = { group: 'Serve it',   choices: ['Brioched', 'Tossed'] }
const DRESS: Options = { group: 'Dressed',    choices: ['Masala', 'Salt n pepper', 'Roasted garlic aioli', 'Chimichurri aioli'] }
const WATER: Options = { group: 'Base',       choices: ['Still', 'Sparkling', 'Coconut'] }
const SWEET: Options = { group: 'Topping',    choices: ['Chocolate', 'Salted caramel', 'Brown butter crumble', 'Cookie crumble'] }

const MENU: Category[] = [
  {
    name: 'Smashed',
    items: [
      { name: 'Chimi Shimi',        build: 'Brioche, smash patty, chimichurri aioli, American cheese', options: SIZE },
      { name: 'Garlic Shroom',      build: 'Brioche, smash patty, shroom & onion jam, roasted garlic aioli, American cheese', options: SIZE },
      { name: 'Sweet Chili Shroom', build: 'Brioche, smash patty, house made chili jam, shroom & onion jam, American cheese', options: SIZE },
    ],
  },
  {
    name: 'Grilled',
    items: [
      { name: 'Chili Jam Chicken', build: 'Brioche, grilled chicken breast, house made chili jam', options: SIZE },
      { name: 'Pub Classic',       build: 'Brioche, 6oz grilled beef patty, ketchup, mustard, pickles, American cheese', options: SIZE },
      { name: 'Pub Shroom',        build: 'Brioche, 6oz grilled beef patty, shroom & onion jam, house made chili jam', options: SIZE },
    ],
  },
  {
    name: 'Fried',
    items: [
      { name: 'Chili Jam Tenders', build: 'Brined and fried tenders, house made chili jam, roasted garlic aioli', options: SERVE },
      { name: 'Buffalo Tenders',   build: 'Brined and fried tenders, buffalo sauce, roasted garlic aioli',        options: SERVE },
      { name: 'Masala Tenders',    build: 'Brined and fried tenders, house masala, chimichurri aioli',            options: SERVE },
    ],
  },
  {
    name: 'Taters',
    items: [
      { name: 'Handcut Fries',    build: 'Hand cut. Triple cooked.',                          options: DRESS },
      { name: 'Curly Fries',      build: 'Twisty. Crispy.',                                   options: DRESS },
      { name: 'Roasted Potatoes', build: 'Smashd. Roasted. Dressed with rustic chimichurri.', options: DRESS },
    ],
  },
  {
    name: 'Electrolytes',
    items: [
      { name: 'Wild Berry',         build: 'Electrolytes', options: WATER },
      { name: 'Pineapple',          build: 'Electrolytes', options: WATER },
      { name: 'Lemon & Lime',       build: 'Electrolytes', options: WATER },
      { name: 'Orange',             build: 'Electrolytes', options: WATER },
      { name: 'Strawberry Limeade', build: 'Electrolytes', options: WATER },
    ],
  },
  {
    name: 'Sweet',
    items: [
      { name: 'Salted Chocolate Mousse', build: 'Chocolate mousse',                         options: SWEET },
      { name: 'Brownie & Ice Cream',     build: 'Brownie, vanilla ice cream',               options: SWEET },
      { name: 'Cookie & Ice Cream',      build: 'Chocolate chip cookie, vanilla ice cream', options: SWEET },
    ],
  },
]

// ─── API plumbing ────────────────────────────────────────────────────────────

let token = ''

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Fastify rejects any request that DECLARES application/json but sends no
  // body, so the content-type only goes on when there is one. A bodyless
  // write (POST /tenants/switch/:id) still needs a body, so it sends `{}`.
  const hasBody = body !== undefined || (method !== 'GET' && method !== 'DELETE')
  const payload = body !== undefined ? JSON.stringify(body) : '{}'
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(hasBody ? { body: payload } : {}),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`)
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

interface LiveModifier { id: string; name: string; priceDeltaCents: number }
interface LiveGroup { id: string; name: string; modifiers: LiveModifier[] }
interface LiveItem { id: string; name: string; description: string | null; priceCents: number; isAvailable: boolean; modifierGroups: LiveGroup[] }
interface LiveCategory { id: string; name: string; items: LiveItem[] }

async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set SERVD_EMAIL and SERVD_PASSWORD in the environment.')
  }
  const res = await api<{ accessToken?: string; twoFactorRequired?: boolean }>(
    'POST', '/auth/login', { email: EMAIL, password: PASSWORD },
  )
  if (!res.accessToken) {
    throw new Error(res.twoFactorRequired
      ? 'That account has 2FA on. Use an account without it, or add the challenge flow here.'
      : 'Login did not return an access token.')
  }
  token = res.accessToken
}

async function main() {
  const unpriced = Object.entries(PRICES).filter(([, p]) => p === null).map(([n]) => n)
  const unpricedOptions = Object.entries(OPTION_DELTAS).filter(([, p]) => p === null).map(([n]) => n)
  const itemCount = MENU.reduce((n, c) => n + c.items.length, 0)

  console.log(`api       ${API}`)
  console.log(`mode      ${APPLY ? 'APPLY — writing' : 'DRY RUN — nothing will be written'}`)
  console.log(`menu      ${MENU.length} categories, ${itemCount} items`)
  if (unpriced.length) console.log(`unpriced  ${unpriced.length}/${itemCount} items → created HIDDEN until priced in admin`)
  if (unpricedOptions.length) console.log(`no delta  ${unpricedOptions.join(', ')} → option left off the item`)
  console.log()

  if (!APPLY) {
    for (const cat of MENU) {
      console.log(`[${cat.name}]`)
      for (const it of cat.items) {
        const p = PRICES[it.name]
        console.log(`   ${it.name.padEnd(26)} ${p == null ? '(no price — hidden)' : `PKR ${(p / 100).toFixed(0)}`.padEnd(19)} ${it.build}`)
      }
    }
    console.log('\nRe-run with --apply to write.')
    return
  }

  await login()

  // flipd is not in the same company as simmer and stackd — it belongs to the
  // GS x Viva JV — and the menu routes scope to the operator's ACTIVE company,
  // not every company they're a member of. So find flipd's company from the
  // public concept list (which spans companies and carries tenantId), switch
  // into it, and switch back at the end so the account is left where it was.
  const publicConcepts = await api<Array<{ slug: string; tenantId: string | null }>>('GET', '/storefront/concepts')
  const flipdTenantId = publicConcepts.find((c) => c.slug === 'flipd')?.tenantId
  if (!flipdTenantId) throw new Error('Could not resolve flipd\'s company from /storefront/concepts.')

  const myTenants = await api<Array<{ id: string; name: string }>>('GET', '/tenants')
  const target = myTenants.find((t) => t.id === flipdTenantId)
  if (!target) {
    throw new Error(`This account is not a member of flipd's company (${flipdTenantId}). Use an account that is.`)
  }

  // Remember where to put the account back. /concepts is scoped to the active
  // company, so whichever company its rows belong to is the current one.
  const before = await api<Array<{ tenantId: string | null }>>('GET', '/concepts')
  const previousTenantId = before[0]?.tenantId ?? null

  let switched = false
  if (previousTenantId !== flipdTenantId) {
    await api('POST', `/tenants/switch/${flipdTenantId}`)
    switched = true
    console.log(`company   switched to ${target.name}`)
  }

  try {
    await importMenu()
  } finally {
    if (switched && previousTenantId) {
      await api('POST', `/tenants/switch/${previousTenantId}`)
      console.log(`company   switched back`)
    }
  }
}

async function importMenu() {
  const concepts = await api<Array<{ id: string; slug: string; name: string }>>('GET', '/concepts')
  const concept = concepts.find((c) => c.slug === 'flipd')
  if (!concept) throw new Error('No concept with slug "flipd" visible in the active company.')
  console.log(`concept   ${concept.name} (${concept.id})\n`)

  const live = await api<LiveCategory[]>('GET', `/menu/${concept.id}`)
  const liveCategories = new Map(live.map((c) => [c.name, c]))
  const liveItems = new Map(live.flatMap((c) => c.items.map((i) => [i.name, i] as const)))

  const keptCategoryIds = new Set<string>()
  const keptItemIds = new Set<string>()

  for (const [ci, cat] of MENU.entries()) {
    let categoryId = liveCategories.get(cat.name)?.id
    if (!categoryId) {
      const created = await api<{ id: string }>('POST', '/menu/categories', {
        conceptId: concept.id, name: cat.name, sortOrder: ci,
      })
      categoryId = created.id
      console.log(`+ category  ${cat.name}`)
    } else {
      await api('PATCH', `/menu/categories/${categoryId}`, { sortOrder: ci })
      console.log(`= category  ${cat.name}`)
    }
    keptCategoryIds.add(categoryId)

    for (const [ii, it] of cat.items.entries()) {
      const price = PRICES[it.name]
      const priceCents = price ?? 0
      const isAvailable = price != null
      const existing = liveItems.get(it.name)

      let itemId: string
      if (!existing) {
        const created = await api<{ id: string }>('POST', '/menu/items', {
          conceptId: concept.id, categoryId, name: it.name,
          description: it.build, priceCents, isAvailable, displayOrder: ii,
        })
        itemId = created.id
        console.log(`  + item    ${it.name}${isAvailable ? '' : '  (hidden — no price)'}`)
      } else {
        itemId = existing.id
        await api('PATCH', `/menu/items/${itemId}`, {
          categoryId, description: it.build, priceCents, isAvailable, displayOrder: ii,
        })
        console.log(`  = item    ${it.name}${isAvailable ? '' : '  (hidden — no price)'}`)
      }
      keptItemIds.add(itemId)

      if (!it.options) continue

      // Every group on this sheet is a "pick how you want it", never an
      // optional add-on, so each is required and exactly one choice.
      const modifiers = it.options.choices
        .map((name, sortOrder) => ({ name, delta: OPTION_DELTAS[name], sortOrder }))
        .filter((m) => {
          if (m.delta == null) { console.log(`    ! skip  ${m.name} — no price delta`); return false }
          return true
        })
        .map((m) => ({ name: m.name, priceDeltaCents: m.delta as number, isDefault: m.sortOrder === 0, sortOrder: m.sortOrder }))

      if (modifiers.length === 0) continue

      // Groups are replaced wholesale rather than diffed: there is one group
      // per item and the option list is short, so rebuilding it is simpler
      // than reconciling it, and the delete is a soft delete.
      for (const g of existing?.modifierGroups ?? []) {
        await api('DELETE', `/menu/modifier-groups/${g.id}`)
      }
      await api('POST', '/menu/modifier-groups', {
        menuItemId: itemId, name: it.options.group,
        minSelect: 1, maxSelect: 1, isRequired: true, sortOrder: 0,
        modifiers,
      })
      console.log(`    ~ ${it.options.group}: ${modifiers.map((m) => m.name).join(', ')}`)
    }
  }

  // Retire what isn't on the sheet. Items first — the API refuses to delete a
  // category that still has items in it.
  let retiredItems = 0
  for (const cat of live) {
    for (const item of cat.items) {
      if (keptItemIds.has(item.id)) continue
      await api('DELETE', `/menu/items/${item.id}`)
      console.log(`- retired item      ${item.name}`)
      retiredItems++
    }
  }
  let retiredCategories = 0
  for (const cat of live) {
    if (keptCategoryIds.has(cat.id)) continue
    await api('DELETE', `/menu/categories/${cat.id}`)
    console.log(`- retired category  ${cat.name}`)
    retiredCategories++
  }

  console.log(`\nretired   ${retiredItems} item(s), ${retiredCategories} category(ies)`)
  console.log('done.')
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
})
