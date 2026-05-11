-- Configurable reservation slot parameters. The restaurant controls these
-- from the admin /configuration/reservation-policy page; the public booking
-- widget reads them from /availability and uses them for slot generation
-- and daypart grouping.
--
-- Defaults match the previously hardcoded values (30-min slots, 90-min
-- duration, Lunch/Afternoon/Dinner/Late night grouping) so the migration
-- is behaviorally a no-op for existing tenants.

ALTER TABLE "reservation_policies"
  ADD COLUMN "slotIntervalMin"    INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "defaultDurationMin" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN "dayparts" JSONB NOT NULL DEFAULT
    '[{"label":"Lunch","startHour":0,"endHour":12},{"label":"Afternoon","startHour":12,"endHour":16},{"label":"Dinner","startHour":16,"endHour":22},{"label":"Late night","startHour":22,"endHour":24}]'::jsonb;
