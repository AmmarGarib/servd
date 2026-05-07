// Restaurant template library. Each entry is a JSON description of what a
// fresh tenant gets when the owner picks this template at signup. Keeps
// "time to first order" under 60 seconds — owners aren't typing menus.
//
// Tip: when you add a new template, also add it to TEMPLATE_KEYS for type-safety.

export interface MenuItemSeed {
  name: string
  nameUrdu?: string
  description?: string
  priceCents: number
  station?: string                       // matches Station.name in this template
  category: string                       // matches Category.name
  recipe?: {
    laborMinutes?: number
    steps?: string
    seasons?: string[]
  }
}

export interface RestaurantTemplate {
  key: string
  emoji: string
  label: string
  blurb: string                          // short pitch, shown on the picker tile
  conceptType: 'restaurant' | 'digital' | 'cart'
  conceptName: string
  primaryColor: string
  taxRate: number
  heroTagline: string
  stations: string[]
  categories: string[]
  items: MenuItemSeed[]
}

export const TEMPLATES: RestaurantTemplate[] = [
  {
    key: 'biryani',
    emoji: '🍛',
    label: 'Biryani / Pakistani classics',
    blurb: 'Charcoal kitchen, copper degs, weekend rush. Comes pre-loaded with chicken/beef biryani, karahi, and chai.',
    conceptType: 'restaurant',
    conceptName: 'My Biryani Place',
    primaryColor: '#D4581A',
    taxRate: 17,
    heroTagline: 'Slow-cooked rice, fast-paced kitchen.',
    stations: ['Hot Kitchen', 'Cold / Sides', 'Drinks'],
    categories: ['Biryanis', 'Karahis & Curries', 'Sides', 'Drinks'],
    items: [
      { name: 'Chicken Biryani',  nameUrdu: 'چکن بریانی',  priceCents: 850_00, category: 'Biryanis', station: 'Hot Kitchen', description: 'Layered basmati, slow-cooked chicken, kewra-saffron finish.', recipe: { laborMinutes: 18, steps: '1. Pre-cook rice 70%.\n2. Layer marinated chicken + rice + saffron milk.\n3. Dum 12 min on coals.\n4. Plate with raita + onions.' } },
      { name: 'Beef Biryani',     nameUrdu: 'بیف بریانی',  priceCents: 1100_00, category: 'Biryanis', station: 'Hot Kitchen', description: 'Tender boti, fragrant rice, classic Karachi preparation.',  recipe: { laborMinutes: 22, steps: '1. Slow-cook beef with whole spices.\n2. Layer with parboiled rice.\n3. Dum 18 min.\n4. Garnish + plate.' } },
      { name: 'Chicken Karahi',   nameUrdu: 'چکن کڑاہی',   priceCents: 1500_00, category: 'Karahis & Curries', station: 'Hot Kitchen', description: 'Boneless chicken, tomato-ginger gravy, finished with green chillies.', recipe: { laborMinutes: 20 } },
      { name: 'Daal Maash',       nameUrdu: 'دال ماش',     priceCents: 550_00, category: 'Karahis & Curries', station: 'Hot Kitchen', description: 'Slow-cooked white lentils with tarka.', recipe: { laborMinutes: 15 } },
      { name: 'Naan',             nameUrdu: 'نان',          priceCents: 80_00, category: 'Sides', station: 'Hot Kitchen' },
      { name: 'Raita',            nameUrdu: 'رائتہ',        priceCents: 120_00, category: 'Sides', station: 'Cold / Sides' },
      { name: 'Salad',            nameUrdu: 'سلاد',         priceCents: 150_00, category: 'Sides', station: 'Cold / Sides' },
      { name: 'Doodh Patti',      nameUrdu: 'دودھ پتی',    priceCents: 200_00, category: 'Drinks', station: 'Drinks' },
      { name: 'Mango Lassi',      priceCents: 350_00, category: 'Drinks', station: 'Drinks', recipe: { seasons: ['summer', 'monsoon'] } },
      { name: 'Coke 500ml',       priceCents: 180_00, category: 'Drinks', station: 'Drinks' },
    ],
  },
  {
    key: 'burger',
    emoji: '🍔',
    label: 'Burger joint / QSR',
    blurb: 'Smash burgers, loaded fries, milkshakes. Built for delivery + counter pickup.',
    conceptType: 'digital',
    conceptName: 'My Burger Joint',
    primaryColor: '#E74C3C',
    taxRate: 17,
    heroTagline: 'Smashed, stacked, sent fast.',
    stations: ['Grill', 'Fryer', 'Cold / Drinks'],
    categories: ['Burgers', 'Fries & Sides', 'Drinks', 'Combos'],
    items: [
      { name: 'Classic Smash',     priceCents: 850_00, category: 'Burgers', station: 'Grill', description: 'Double patty, aged cheddar, special sauce, brioche.',     recipe: { laborMinutes: 8 } },
      { name: 'Spicy Smash',       priceCents: 950_00, category: 'Burgers', station: 'Grill', description: 'Double patty, pepperjack, jalapeños, chipotle aioli.',     recipe: { laborMinutes: 8 } },
      { name: 'Crispy Chicken',    priceCents: 900_00, category: 'Burgers', station: 'Fryer', description: 'Buttermilk-brined fillet, slaw, pickles, brioche.',         recipe: { laborMinutes: 9 } },
      { name: 'Veggie Smash',      priceCents: 750_00, category: 'Burgers', station: 'Grill', description: 'Black-bean patty, lettuce, tomato, vegan mayo.',           recipe: { laborMinutes: 8 } },
      { name: 'Regular Fries',     priceCents: 250_00, category: 'Fries & Sides', station: 'Fryer', recipe: { laborMinutes: 4 } },
      { name: 'Loaded Fries',      priceCents: 450_00, category: 'Fries & Sides', station: 'Fryer', description: 'Fries, cheese sauce, jalapeños, scallions.',          recipe: { laborMinutes: 6 } },
      { name: 'Onion Rings',       priceCents: 280_00, category: 'Fries & Sides', station: 'Fryer' },
      { name: 'Coke',              priceCents: 180_00, category: 'Drinks', station: 'Cold / Drinks' },
      { name: 'Chocolate Shake',   priceCents: 400_00, category: 'Drinks', station: 'Cold / Drinks' },
      { name: 'Combo: Smash+Fries+Coke', priceCents: 1200_00, category: 'Combos', station: 'Grill' },
    ],
  },
  {
    key: 'cafe',
    emoji: '☕',
    label: 'Cafe / brunch',
    blurb: 'Espresso bar, all-day brunch, pastries. Heavy on cold drinks in summer.',
    conceptType: 'restaurant',
    conceptName: 'My Cafe',
    primaryColor: '#8B6F4E',
    taxRate: 17,
    heroTagline: 'Slow mornings, strong coffee.',
    stations: ['Espresso Bar', 'Hot Kitchen', 'Cold Bar / Pastry'],
    categories: ['Coffee', 'Cold Drinks', 'Brunch', 'Pastries'],
    items: [
      { name: 'Espresso',          priceCents: 250_00, category: 'Coffee', station: 'Espresso Bar', recipe: { laborMinutes: 2 } },
      { name: 'Cappuccino',        priceCents: 350_00, category: 'Coffee', station: 'Espresso Bar', recipe: { laborMinutes: 3 } },
      { name: 'Flat White',        priceCents: 380_00, category: 'Coffee', station: 'Espresso Bar', recipe: { laborMinutes: 3 } },
      { name: 'Latte',             priceCents: 400_00, category: 'Coffee', station: 'Espresso Bar', recipe: { laborMinutes: 3 } },
      { name: 'Iced Latte',        priceCents: 420_00, category: 'Cold Drinks', station: 'Cold Bar / Pastry', recipe: { seasons: ['summer', 'monsoon'] } },
      { name: 'Iced Mocha',        priceCents: 450_00, category: 'Cold Drinks', station: 'Cold Bar / Pastry', recipe: { seasons: ['summer', 'monsoon'] } },
      { name: 'Avocado Toast',     priceCents: 850_00, category: 'Brunch', station: 'Hot Kitchen', description: 'Sourdough, smashed avo, chilli flakes, soft-poached egg.', recipe: { laborMinutes: 10 } },
      { name: 'Eggs Benedict',     priceCents: 1100_00, category: 'Brunch', station: 'Hot Kitchen', recipe: { laborMinutes: 12 } },
      { name: 'Pancake Stack',     priceCents: 750_00, category: 'Brunch', station: 'Hot Kitchen', recipe: { laborMinutes: 10 } },
      { name: 'Croissant',         priceCents: 250_00, category: 'Pastries', station: 'Cold Bar / Pastry' },
      { name: 'Cinnamon Roll',     priceCents: 320_00, category: 'Pastries', station: 'Cold Bar / Pastry' },
    ],
  },
  {
    key: 'fine_dining',
    emoji: '🍷',
    label: 'Fine dining',
    blurb: 'Plated service, tasting menus, wine pairings. Course pacing matters.',
    conceptType: 'restaurant',
    conceptName: 'My Restaurant',
    primaryColor: '#2D4A3E',
    taxRate: 17,
    heroTagline: 'Considered, plated, paced.',
    stations: ['Garde Manger / Cold', 'Hot Line', 'Pastry', 'Bar'],
    categories: ['Starters', 'Mains', 'Desserts', 'Drinks'],
    items: [
      { name: 'Beetroot & Labneh',     priceCents: 1100_00, category: 'Starters', station: 'Garde Manger / Cold', recipe: { laborMinutes: 8 } },
      { name: 'Burrata & Heirlooms',   priceCents: 1300_00, category: 'Starters', station: 'Garde Manger / Cold', recipe: { laborMinutes: 8, seasons: ['spring', 'summer'] } },
      { name: 'Chicken Liver Pâté',    priceCents: 1200_00, category: 'Starters', station: 'Garde Manger / Cold' },
      { name: 'Pan-seared Sea Bass',   priceCents: 2800_00, category: 'Mains', station: 'Hot Line', recipe: { laborMinutes: 18 } },
      { name: 'Lamb Shank',            priceCents: 3200_00, category: 'Mains', station: 'Hot Line', recipe: { laborMinutes: 14, seasons: ['winter', 'autumn'] } },
      { name: 'Mushroom Risotto',      priceCents: 1900_00, category: 'Mains', station: 'Hot Line', recipe: { laborMinutes: 22 } },
      { name: 'Tiramisu',              priceCents: 800_00, category: 'Desserts', station: 'Pastry' },
      { name: 'Chocolate Fondant',     priceCents: 850_00, category: 'Desserts', station: 'Pastry', recipe: { laborMinutes: 11 } },
      { name: 'House Mocktail',        priceCents: 600_00, category: 'Drinks', station: 'Bar' },
      { name: 'Sparkling Water',       priceCents: 200_00, category: 'Drinks', station: 'Bar' },
    ],
  },
  {
    key: 'cloud_kitchen',
    emoji: '🛵',
    label: 'Cloud kitchen / multi-brand',
    blurb: 'Delivery-only, multiple brands out of one kitchen. Built for Foodpanda + Careem volume.',
    conceptType: 'digital',
    conceptName: 'Brand A',
    primaryColor: '#6366F1',
    taxRate: 17,
    heroTagline: 'Delivery-first. Built for the surge.',
    stations: ['Hot Line', 'Cold Bar', 'Packing'],
    categories: ['Bestsellers', 'Mains', 'Sides', 'Drinks'],
    items: [
      { name: 'Crispy Chicken Burger', priceCents: 750_00, category: 'Bestsellers', station: 'Hot Line', recipe: { laborMinutes: 9 } },
      { name: 'Shawarma Wrap',         priceCents: 650_00, category: 'Bestsellers', station: 'Hot Line', recipe: { laborMinutes: 7 } },
      { name: 'Chicken Tikka Roll',    priceCents: 550_00, category: 'Bestsellers', station: 'Hot Line', recipe: { laborMinutes: 8 } },
      { name: 'Loaded Fries',          priceCents: 400_00, category: 'Sides', station: 'Hot Line' },
      { name: 'Garlic Bread',          priceCents: 280_00, category: 'Sides', station: 'Hot Line' },
      { name: 'Coleslaw',              priceCents: 200_00, category: 'Sides', station: 'Cold Bar' },
      { name: 'Coke',                  priceCents: 180_00, category: 'Drinks', station: 'Cold Bar' },
      { name: 'Mineral Water',         priceCents: 100_00, category: 'Drinks', station: 'Cold Bar' },
    ],
  },
]

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key)
export type TemplateKey = (typeof TEMPLATE_KEYS)[number]

export function getTemplate(key: string): RestaurantTemplate | null {
  return TEMPLATES.find((t) => t.key === key) ?? null
}
