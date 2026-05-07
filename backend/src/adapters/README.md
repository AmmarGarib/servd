# backend/src/adapters

Each adapter normalises a third-party payload into our canonical types (`OrderDTO` for order sources, `PaymentDTO` for gateways).

## Order sources

- [`foodpanda/`](./foodpanda/) — Foodpanda webhook adapter.
- [`careem/`](./careem/) — Careem aggregator (mirrors Foodpanda's pattern).
- [`whatsapp/`](./whatsapp/) — WhatsApp Cloud API → conversational order builder.

## Payments

- [`payment/`](./payment/) — Generic payment adapter interface.
- [`keenu/`](./keenu/) — Keenu card processor.
- [`jazzcash/`](./jazzcash/) — JazzCash mobile wallet.
- [`easypaisa/`](./easypaisa/) — EasyPaisa wallet.

## Compliance

- [`fbr/`](./fbr/) — Pakistan FBR e-invoice submission adapter.
