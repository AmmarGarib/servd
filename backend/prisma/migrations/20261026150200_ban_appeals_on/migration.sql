-- C22 (owner, 2026-10-26): switch customer ban appeals ON. Platform Setting 'crm.banAppealsEnabled' holds the JSON
-- written by complaints/appeals.ts writeBanAppealsSetting. Only when no value is stored yet — a CEO's own on/off
-- choice is never overwritten, and the CEO can still switch it off on Complaints.
INSERT INTO "settings" ("key", "value", "updatedAt")
VALUES (
  'crm.banAppealsEnabled',
  '{"enabled":true,"reason":"Switched on by the owner (2026-10-26)","updatedAt":"2026-10-26T00:00:00.000Z","updatedById":null}',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
