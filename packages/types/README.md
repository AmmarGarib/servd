# packages/types

`@servd/types` — canonical TypeScript types shared across backend + frontend.

The most important type is `OrderDTO` — every adapter (Foodpanda, Careem, POS, storefront, WhatsApp) normalises its incoming payload into this shape before `ingestOrder()` persists it. Keeping this contract stable is what lets us add new order sources without touching the order pipeline.
