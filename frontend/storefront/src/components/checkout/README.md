# checkout

Source files for `frontend/storefront/src/components/checkout`.

- `DeliveryPin.tsx` — the map where a customer sets the drop point for a
  delivery. Used by `/<concept>/checkout` and by the address form on
  `/account`. It uses Leaflet with OpenStreetMap tiles. Leaflet is imported
  on demand inside an effect, so it gets its own async chunk and is not in
  the menu or home bundles. Leaflet's CSS is a trimmed copy inlined in the
  component, so no third-party stylesheet is loaded. The pin is a `divIcon`
  (inline SVG in servd purple and green). Leaflet's default marker images
  break under bundlers, so they are not used. The customer can tap the map,
  drag the pin, use "Use my current location" (geolocation, with messages for
  denied, unavailable and timeout), or, from the keyboard, use the arrow keys
  and press Enter to drop the pin at the map centre. The map opens on
  `center` (the kitchen, when known), otherwise on Karachi. Keep the OSM
  attribution: the OpenStreetMap licence requires it.
