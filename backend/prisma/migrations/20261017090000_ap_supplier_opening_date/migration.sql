-- AP (finance final, item 4): a supplier's opening balance is posted dated at
-- the day it is brought forward (the company's go-live for that supplier),
-- never "today". NULL = the supplier's createdAt (the day it was set up in
-- servd). procurement/openingBalance.ts reads it.
ALTER TABLE "suppliers" ADD COLUMN "openingBalanceDate" DATE;
