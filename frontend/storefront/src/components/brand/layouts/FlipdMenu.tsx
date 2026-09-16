// flipd menu — transcribed from the menu spec sheet, not paraphrased.
//
// The brand book's voice rule is "Plain-spoken: names the ingredient, skips
// the adjective", and its first core value is "The spec is the boss". So the
// build line IS the description — there is no marketing copy under any item,
// because inventing some would break both rules at once.
//
// This is a marketing menu, deliberately without prices: the till and the
// ordering flow own money, and a second copy of the price list on a brand page
// is a thing that silently goes stale. "See the full menu" sends people to the
// real ordering surface.

export interface FlipdMenuItem {
  name: string
  build: string
  options?: string[]
}

export interface FlipdMenuSection {
  section: string
  note?: string
  items: FlipdMenuItem[]
}

export interface FlipdMenuGroup {
  page: string
  sections: FlipdMenuSection[]
}

const SIZES = ['Single', 'Double', 'Lettuce wrap']

export const FLIPD_MENU: FlipdMenuGroup[] = [
  {
    page: 'Burgers',
    sections: [
      {
        section: 'Smashed',
        items: [
          { name: 'Chimi Shimi',        build: 'Brioche, smash patty, chimichurri aioli, American cheese', options: SIZES },
          { name: 'Garlic Shroom',      build: 'Brioche, smash patty, shroom & onion jam, roasted garlic aioli, American cheese', options: SIZES },
          { name: 'Sweet Chili Shroom', build: 'Brioche, smash patty, house made chili jam, shroom & onion jam, American cheese', options: SIZES },
        ],
      },
      {
        section: 'Grilled',
        items: [
          { name: 'Chili Jam Chicken', build: 'Brioche, grilled chicken breast, house made chili jam', options: SIZES },
          { name: 'Pub Classic',       build: 'Brioche, 6oz grilled beef patty, ketchup, mustard, pickles, American cheese', options: SIZES },
          { name: 'Pub Shroom',        build: 'Brioche, 6oz grilled beef patty, shroom & onion jam, house made chili jam', options: SIZES },
        ],
      },
    ],
  },
  {
    page: 'Sides',
    sections: [
      {
        section: 'Fried',
        items: [
          { name: 'Chili Jam Tenders', build: 'Brined and fried tenders, house made chili jam, roasted garlic aioli', options: ['Brioched', 'Tossed'] },
          { name: 'Buffalo Tenders',   build: 'Brined and fried tenders, buffalo sauce, roasted garlic aioli',        options: ['Brioched', 'Tossed'] },
          { name: 'Masala Tenders',    build: 'Brined and fried tenders, house masala, chimichurri aioli',            options: ['Brioched', 'Tossed'] },
        ],
      },
      {
        section: 'Taters',
        note: 'Dressed however you want it.',
        items: [
          { name: 'Handcut Fries',    build: 'Hand cut. Triple cooked.',                          options: ['Masala', 'Salt n pepper', 'Roasted garlic aioli', 'Chimichurri aioli'] },
          { name: 'Curly Fries',      build: 'Twisty. Crispy.',                                   options: ['Masala', 'Salt n pepper', 'Roasted garlic aioli', 'Chimichurri aioli'] },
          { name: 'Roasted Potatoes', build: 'Smashd. Roasted. Dressed with rustic chimichurri.', options: ['Masala', 'Salt n pepper', 'Roasted garlic aioli', 'Chimichurri aioli'] },
        ],
      },
    ],
  },
  {
    page: 'Drinks',
    sections: [
      {
        section: 'Electrolytes',
        // Straight from the mission page: "Drinks follow the same logic:
        // electrolytes, coconut water, sparkling water; fuel that fits the
        // food and fits the court."
        note: 'Fuel that fits the food.',
        items: [
          { name: 'Wild Berry',        build: 'Electrolytes', options: ['Sparkling', 'Still', 'Coconut'] },
          { name: 'Pineapple',         build: 'Electrolytes', options: ['Sparkling', 'Still', 'Coconut'] },
          { name: 'Lemon & Lime',      build: 'Electrolytes', options: ['Sparkling', 'Still', 'Coconut'] },
          { name: 'Orange',            build: 'Electrolytes', options: ['Sparkling', 'Still', 'Coconut'] },
          { name: 'Strawberry Limeade', build: 'Electrolytes', options: ['Sparkling', 'Still', 'Coconut'] },
        ],
      },
    ],
  },
  {
    page: 'Flip Side',
    sections: [
      {
        section: 'Sweet',
        items: [
          { name: 'Salted Chocolate Mousse', build: 'Chocolate mousse',                    options: ['Chocolate', 'Salted caramel', 'Brown butter crumble', 'Cookie crumble'] },
          { name: 'Brownie & Ice Cream',     build: 'Brownie, vanilla ice cream',           options: ['Chocolate', 'Salted caramel', 'Brown butter crumble', 'Cookie crumble'] },
          { name: 'Cookie & Ice Cream',      build: 'Chocolate chip cookie, vanilla ice cream', options: ['Chocolate', 'Salted caramel', 'Brown butter crumble', 'Cookie crumble'] },
        ],
      },
    ],
  },
]
