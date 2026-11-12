-- One piece of a weighed ingredient (owner, 2026-11-12: "its 1 slice of nurpur cheese not 1g"). A recipe line may be
-- typed in pieces; it is still stored in grams / ml. Display only.
ALTER TABLE "ingredient_masters" ADD COLUMN "pieceGrams" DOUBLE PRECISION, ADD COLUMN "pieceLabel" TEXT;
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_piece_chk" CHECK ("pieceGrams" IS NULL OR "pieceGrams" > 0);
