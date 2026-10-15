# tax

Redirect only: `/configuration/tax` → `/connectors/pos` (Dev → API → POS connector).

FBR / SRB filing goes through the external fiscal POS via the POS connector, and the brand POS ids are edited on that page. Cash / card GST rates are per brand in CEO → Brands → Tax registration.

## Files

- `page.tsx` — server redirect
