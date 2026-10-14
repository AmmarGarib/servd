// Stock-count postings moved to accounting/inventoryPosting.ts (finance wave
// B, food cost on FIFO lots): a count is valued from its stored line values —
// the FIFO value of a 'count_loss', the lot of a 'count_gain' or an opening
// count — never the item's cost now. This file only re-exports them so
// existing importers keep compiling; it is deleted once none remains.
export { postStockCount, stockCountAdjustment, COUNT_SOURCE_TYPE } from '../accounting/inventoryPosting.js'
