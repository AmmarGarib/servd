import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
async function main() {
    console.info('🌱 Seeding servd database...');
    // ─── Concepts ──────────────────────────────────────────────────────────────
    const simmer = await prisma.concept.upsert({
        where: { slug: 'simmer' },
        update: {},
        create: {
            name: 'Simmer',
            slug: 'simmer',
            type: 'restaurant',
            description: 'Approachable but elegant mocktails + small plates. Plated service.',
            primaryColor: '#2D4A3E',
            taxRate: 17,
            isActive: true,
        },
    });
    const stax = await prisma.concept.upsert({
        where: { slug: 'stax' },
        update: {},
        create: {
            name: 'Stax',
            slug: 'stax',
            type: 'digital',
            description: 'Gourmet sandwiches, layered fries, house-made sauces. Digital brand.',
            primaryColor: '#D4581A',
            taxRate: 17,
            isActive: true,
        },
    });
    const strata = await prisma.concept.upsert({
        where: { slug: 'strata' },
        update: {},
        create: {
            name: 'Strata',
            slug: 'strata',
            type: 'digital',
            description: 'Clean label, high protein, chef-driven bowls and wraps.',
            primaryColor: '#4A7C59',
            taxRate: 17,
            isActive: true,
        },
    });
    const craveman = await prisma.concept.upsert({
        where: { slug: 'craveman' },
        update: {},
        create: {
            name: 'Craveman',
            slug: 'craveman',
            type: 'digital',
            description: 'Indulgent desi fusion bowls and wraps in new flavors.',
            primaryColor: '#8B1A1A',
            taxRate: 17,
            isActive: true,
        },
    });
    const garnishStation = await prisma.concept.upsert({
        where: { slug: 'garnish-station' },
        update: {},
        create: {
            name: 'Garnish Station',
            slug: 'garnish-station',
            type: 'cart',
            description: 'Top-your-own bowls and wraps. Physical outdoor cart.',
            primaryColor: '#C4A24A',
            taxRate: 17,
            isActive: true,
        },
    });
    console.info('✓ Concepts seeded:', [simmer, stax, strata, craveman, garnishStation].map((c) => c.name));
    // ─── Kitchen Stations ─────────────────────────────────────────────────────
    const stationDefs = [
        { name: 'Grill', displayOrder: 0 },
        { name: 'Cold', displayOrder: 1 },
        { name: 'Drinks', displayOrder: 2 },
        { name: 'Cart', displayOrder: 3 },
        { name: 'Expo / Pass', displayOrder: 4 },
    ];
    for (const concept of [simmer, stax, strata, craveman, garnishStation]) {
        for (const def of stationDefs) {
            await prisma.station.upsert({
                where: {
                    // No unique constraint on (conceptId, name), so use findFirst + create
                    id: `${concept.slug}-${def.name.toLowerCase().replace(/\s+/g, '-')}`,
                },
                update: {},
                create: {
                    id: `${concept.slug}-${def.name.toLowerCase().replace(/\s+/g, '-')}`,
                    conceptId: concept.id,
                    name: def.name,
                    displayOrder: def.displayOrder,
                    isActive: true,
                },
            });
        }
    }
    console.info('✓ Kitchen stations seeded');
    // ─── Chart of Accounts ────────────────────────────────────────────────────
    const accounts = [
        { code: '1001', name: 'Cash on Hand', type: 'asset' },
        { code: '1002', name: 'Card / Gateway Receivable', type: 'asset' },
        { code: '1100', name: 'Inventory', type: 'asset' },
        { code: '2001', name: 'Sales Tax Payable (FBR GST)', type: 'liability' },
        { code: '2002', name: 'Platform Commission Payable', type: 'liability' },
        { code: '4001', name: 'Simmer Revenue', type: 'revenue' },
        { code: '4002', name: 'Stax Revenue', type: 'revenue' },
        { code: '4003', name: 'Strata Revenue', type: 'revenue' },
        { code: '4004', name: 'Craveman Revenue', type: 'revenue' },
        { code: '4005', name: 'Garnish Station Revenue', type: 'revenue' },
        { code: '4100', name: 'Delivery Commission Deductions', type: 'expense' },
        { code: '5001', name: 'Cost of Goods Sold', type: 'expense' },
        { code: '5002', name: 'Packaging', type: 'expense' },
        { code: '6001', name: 'Discounts Given', type: 'expense' },
        { code: '6002', name: 'Refunds', type: 'expense' },
        { code: '6003', name: 'Loyalty Redemptions', type: 'expense' },
    ];
    for (const acc of accounts) {
        await prisma.account.upsert({
            where: { code: acc.code },
            update: {},
            create: { ...acc, isActive: true },
        });
    }
    console.info('✓ Chart of accounts seeded');
    // ─── Admin user ────────────────────────────────────────────────────────────
    const adminPassword = await bcrypt.hash('admin123!', 12);
    const adminPin = await bcrypt.hash('1234', 10);
    await prisma.user.upsert({
        where: { email: 'admin@servd.pk' },
        update: {},
        create: {
            name: 'Admin',
            email: 'admin@servd.pk',
            password: adminPassword,
            pin: adminPin,
            role: 'admin',
            isActive: true,
        },
    });
    console.info('✓ Admin user seeded (email: admin@servd.pk, password: admin123!, PIN: 1234)');
    // ─── Sample categories & menu items (Simmer) ──────────────────────────────
    const mocktailCat = await prisma.category.upsert({
        where: { id: 'simmer-mocktails' },
        update: {},
        create: {
            id: 'simmer-mocktails',
            conceptId: simmer.id,
            name: 'Mocktails',
            sortOrder: 0,
        },
    });
    const smallPlatesCat = await prisma.category.upsert({
        where: { id: 'simmer-small-plates' },
        update: {},
        create: {
            id: 'simmer-small-plates',
            conceptId: simmer.id,
            name: 'Small Plates',
            sortOrder: 1,
        },
    });
    await prisma.menuItem.upsert({
        where: { id: 'simmer-item-001' },
        update: {},
        create: {
            id: 'simmer-item-001',
            conceptId: simmer.id,
            categoryId: mocktailCat.id,
            name: 'Simmer Signature Mocktail',
            description: 'House blend, seasonal fruit, soda',
            priceCents: 75000, // PKR 750
            isAvailable: true,
            displayOrder: 0,
            stationId: `simmer-drinks`,
        },
    });
    await prisma.menuItem.upsert({
        where: { id: 'simmer-item-002' },
        update: {},
        create: {
            id: 'simmer-item-002',
            conceptId: simmer.id,
            categoryId: smallPlatesCat.id,
            name: 'Truffle Fries',
            description: 'Hand-cut, truffle oil, parmesan, herbs',
            priceCents: 85000, // PKR 850
            isAvailable: true,
            displayOrder: 0,
            stationId: `simmer-grill`,
        },
    });
    // Simmer: extra items
    const drinksMoreCat = await prisma.category.upsert({
        where: { id: 'simmer-drinks' },
        update: {},
        create: { id: 'simmer-drinks', conceptId: simmer.id, name: 'Drinks', sortOrder: 2 },
    });
    for (const [i, item] of [
        { name: 'Sparkling Lemonade', description: 'Fresh lemon, mint, sparkling water', priceCents: 55000, station: 'simmer-drinks' },
        { name: 'Berry Bliss', description: 'Mixed berries, basil, lime, soda', priceCents: 65000, station: 'simmer-drinks' },
        { name: 'Watermelon Cooler', description: 'Fresh watermelon, ginger, lemon', priceCents: 55000, station: 'simmer-drinks' },
        { name: 'Bruschetta Board', description: 'Sourdough, heirloom tomatoes, basil oil', priceCents: 90000, station: 'simmer-cold' },
        { name: 'Crispy Calamari', description: 'Lemon aioli, chilli flakes', priceCents: 110000, station: 'simmer-grill' },
        { name: 'Burrata & Peach', description: 'Stracciatella, prosciutto, balsamic', priceCents: 125000, station: 'simmer-cold' },
    ].entries()) {
        await prisma.menuItem.upsert({
            where: { id: `simmer-item-${String(i + 3).padStart(3, '0')}` },
            update: {},
            create: { id: `simmer-item-${String(i + 3).padStart(3, '0')}`, conceptId: simmer.id,
                categoryId: i < 3 ? drinksMoreCat.id : smallPlatesCat.id,
                name: item.name, description: item.description, priceCents: item.priceCents,
                isAvailable: true, displayOrder: i + 1, stationId: item.station },
        });
    }
    console.info('✓ Sample menu items seeded for Simmer');
    // ─── Stax menu ────────────────────────────────────────────────────────────
    const staxSandwichesCat = await prisma.category.upsert({
        where: { id: 'stax-sandwiches' }, update: {},
        create: { id: 'stax-sandwiches', conceptId: stax.id, name: 'Sandwiches', sortOrder: 0 },
    });
    const staxFriesCat = await prisma.category.upsert({
        where: { id: 'stax-fries' }, update: {},
        create: { id: 'stax-fries', conceptId: stax.id, name: 'Loaded Fries', sortOrder: 1 },
    });
    const staxDrinksCat = await prisma.category.upsert({
        where: { id: 'stax-drinks' }, update: {},
        create: { id: 'stax-drinks', conceptId: stax.id, name: 'Drinks', sortOrder: 2 },
    });
    for (const [i, item] of [
        { name: 'The Stax Classic', desc: 'Smash patty, aged cheddar, pickles, special sauce, brioche', price: 120000, cat: staxSandwichesCat.id, station: 'stax-grill' },
        { name: 'Crispy Chicken', desc: 'Fried thigh, slaw, chipotle mayo, potato bun', price: 115000, cat: staxSandwichesCat.id, station: 'stax-grill' },
        { name: 'Mushroom Swiss Melt', desc: 'Sautéed mushrooms, swiss, caramelised onion', price: 110000, cat: staxSandwichesCat.id, station: 'stax-grill' },
        { name: 'Original Stax', desc: 'Seasoned fries, cheese sauce, jalapeños', price: 75000, cat: staxFriesCat.id, station: 'stax-cold' },
        { name: 'Pulled Chicken Fries', desc: 'Shredded chicken, BBQ, pickled onions', price: 90000, cat: staxFriesCat.id, station: 'stax-cold' },
        { name: 'Truffle Parmesan', desc: 'Truffle oil, parmesan, chives, truffle mayo', price: 95000, cat: staxFriesCat.id, station: 'stax-cold' },
        { name: 'Classic Cola', desc: '330ml can', price: 20000, cat: staxDrinksCat.id, station: 'stax-drinks' },
        { name: 'Iced Lemonade', desc: 'House-made, fresh lemon', price: 35000, cat: staxDrinksCat.id, station: 'stax-drinks' },
    ].entries()) {
        await prisma.menuItem.upsert({
            where: { id: `stax-item-${String(i + 1).padStart(3, '0')}` }, update: {},
            create: { id: `stax-item-${String(i + 1).padStart(3, '0')}`, conceptId: stax.id,
                categoryId: item.cat, name: item.name, description: item.desc,
                priceCents: item.price, isAvailable: true, displayOrder: i, stationId: item.station },
        });
    }
    console.info('✓ Stax menu seeded');
    // ─── Strata menu ──────────────────────────────────────────────────────────
    const strataBowlsCat = await prisma.category.upsert({
        where: { id: 'strata-bowls' }, update: {},
        create: { id: 'strata-bowls', conceptId: strata.id, name: 'Protein Bowls', sortOrder: 0 },
    });
    const strataWrapsCat = await prisma.category.upsert({
        where: { id: 'strata-wraps' }, update: {},
        create: { id: 'strata-wraps', conceptId: strata.id, name: 'Wraps', sortOrder: 1 },
    });
    const strataDrinksCat = await prisma.category.upsert({
        where: { id: 'strata-drinks' }, update: {},
        create: { id: 'strata-drinks', conceptId: strata.id, name: 'Drinks', sortOrder: 2 },
    });
    for (const [i, item] of [
        { name: 'Grilled Chicken Bowl', desc: 'Brown rice, grilled chicken, roasted veg, tahini dressing', price: 110000, cat: strataBowlsCat.id },
        { name: 'Beef Steak Bowl', desc: 'Quinoa, seared beef strips, chimichurri, pickled cabbage', price: 135000, cat: strataBowlsCat.id },
        { name: 'Falafel & Hummus Bowl', desc: 'Herbed falafel, hummus, tabbouleh, pita chips', price: 95000, cat: strataBowlsCat.id },
        { name: 'High Protein Wrap', desc: 'Chicken, egg white, greens, avocado, whole wheat tortilla', price: 100000, cat: strataWrapsCat.id },
        { name: 'Shawarma Wrap', desc: 'Spiced chicken, garlic sauce, fries, pickles, tortilla', price: 110000, cat: strataWrapsCat.id },
        { name: 'Protein Shake', desc: 'Whey, banana, almond milk — 30g protein', price: 45000, cat: strataDrinksCat.id },
    ].entries()) {
        await prisma.menuItem.upsert({
            where: { id: `strata-item-${String(i + 1).padStart(3, '0')}` }, update: {},
            create: { id: `strata-item-${String(i + 1).padStart(3, '0')}`, conceptId: strata.id,
                categoryId: item.cat, name: item.name, description: item.desc,
                priceCents: item.price, isAvailable: true, displayOrder: i, stationId: `strata-grill` },
        });
    }
    console.info('✓ Strata menu seeded');
    // ─── Craveman menu ────────────────────────────────────────────────────────
    const cravemanBowlsCat = await prisma.category.upsert({
        where: { id: 'craveman-bowls' }, update: {},
        create: { id: 'craveman-bowls', conceptId: craveman.id, name: 'Desi Bowls', sortOrder: 0 },
    });
    const cravemanWrapsCat = await prisma.category.upsert({
        where: { id: 'craveman-wraps' }, update: {},
        create: { id: 'craveman-wraps', conceptId: craveman.id, name: 'Fusion Wraps', sortOrder: 1 },
    });
    const cravemanSidesCat = await prisma.category.upsert({
        where: { id: 'craveman-sides' }, update: {},
        create: { id: 'craveman-sides', conceptId: craveman.id, name: 'Sides & Drinks', sortOrder: 2 },
    });
    for (const [i, item] of [
        { name: 'Butter Chicken Bowl', desc: 'Basmati rice, rich butter chicken, raita, pickled onion', price: 120000, cat: cravemanBowlsCat.id },
        { name: 'Seekh Kebab Bowl', desc: 'Charred seekh, saffron rice, green chutney, naan crisps', price: 130000, cat: cravemanBowlsCat.id },
        { name: 'Daal Chawal Bowl', desc: 'Masoor dal, basmati, tarka, achaar', price: 85000, cat: cravemanBowlsCat.id },
        { name: 'Karahi Wrap', desc: 'Slow-cooked karahi chicken, paratha wrap, chutney', price: 110000, cat: cravemanWrapsCat.id },
        { name: 'Tikka Fusion Wrap', desc: 'Tikka chicken, coleslaw, cheese, whole wheat tortilla', price: 115000, cat: cravemanWrapsCat.id },
        { name: 'Raita', desc: 'House-made, cucumber, cumin', price: 20000, cat: cravemanSidesCat.id },
        { name: 'Lassi (Sweet)', desc: 'Full-fat yoghurt, rosewater', price: 35000, cat: cravemanSidesCat.id },
    ].entries()) {
        await prisma.menuItem.upsert({
            where: { id: `craveman-item-${String(i + 1).padStart(3, '0')}` }, update: {},
            create: { id: `craveman-item-${String(i + 1).padStart(3, '0')}`, conceptId: craveman.id,
                categoryId: item.cat, name: item.name, description: item.desc,
                priceCents: item.price, isAvailable: true, displayOrder: i, stationId: `craveman-grill` },
        });
    }
    console.info('✓ Craveman menu seeded');
    // ─── Garnish Station menu ─────────────────────────────────────────────────
    const gsBowlsCat = await prisma.category.upsert({
        where: { id: 'gs-bowls' }, update: {},
        create: { id: 'gs-bowls', conceptId: garnishStation.id, name: 'Build Your Bowl', sortOrder: 0 },
    });
    const gsToppingsCat = await prisma.category.upsert({
        where: { id: 'gs-toppings' }, update: {},
        create: { id: 'gs-toppings', conceptId: garnishStation.id, name: 'Add-ons', sortOrder: 1 },
    });
    const gsDrinksCat = await prisma.category.upsert({
        where: { id: 'gs-drinks' }, update: {},
        create: { id: 'gs-drinks', conceptId: garnishStation.id, name: 'Drinks', sortOrder: 2 },
    });
    for (const [i, item] of [
        { name: 'Classic Bowl', desc: 'Lettuce base, 3 toppings of your choice, house dressing', price: 65000, cat: gsBowlsCat.id },
        { name: 'Loaded Bowl', desc: 'Grain base, 5 toppings, protein, premium sauce', price: 90000, cat: gsBowlsCat.id },
        { name: 'Mini Bowl', desc: 'Small portion, 2 toppings, dressing', price: 45000, cat: gsBowlsCat.id },
        { name: 'Grilled Chicken (+)', desc: 'Add grilled chicken strips', price: 15000, cat: gsToppingsCat.id },
        { name: 'Feta Cheese (+)', desc: 'Crumbled feta', price: 10000, cat: gsToppingsCat.id },
        { name: 'Avocado (+)', desc: 'Fresh sliced avocado', price: 15000, cat: gsToppingsCat.id },
        { name: 'Sparkling Water', desc: '500ml', price: 15000, cat: gsDrinksCat.id },
        { name: 'Fresh Juice', desc: 'Seasonal, daily rotation', price: 30000, cat: gsDrinksCat.id },
    ].entries()) {
        await prisma.menuItem.upsert({
            where: { id: `gs-item-${String(i + 1).padStart(3, '0')}` }, update: {},
            create: { id: `gs-item-${String(i + 1).padStart(3, '0')}`, conceptId: garnishStation.id,
                categoryId: item.cat, name: item.name, description: item.desc,
                priceCents: item.price, isAvailable: true, displayOrder: i, stationId: `garnish-station-cart` },
        });
    }
    console.info('✓ Garnish Station menu seeded');
    // ─── Tables (Simmer restaurant) ───────────────────────────────────────────
    const tableDefs = [
        { label: 'T1', capacity: 2, floorSection: 'Main' },
        { label: 'T2', capacity: 4, floorSection: 'Main' },
        { label: 'T3', capacity: 4, floorSection: 'Main' },
        { label: 'T4', capacity: 6, floorSection: 'Main' },
        { label: 'T5', capacity: 2, floorSection: 'Window' },
        { label: 'T6', capacity: 4, floorSection: 'Window' },
        { label: 'Bar-1', capacity: 1, floorSection: 'Bar' },
        { label: 'Bar-2', capacity: 1, floorSection: 'Bar' },
    ];
    for (const t of tableDefs) {
        await prisma.table.upsert({
            where: { id: `simmer-${t.label.toLowerCase()}` },
            update: {},
            create: {
                id: `simmer-${t.label.toLowerCase()}`,
                conceptId: simmer.id,
                ...t,
                status: 'available',
            },
        });
    }
    console.info('✓ Simmer tables seeded');
    console.info('\n✅ Seed complete');
}
main()
    .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
})
    .finally(() => {
    void prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map