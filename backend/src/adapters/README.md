# backend/src/adapters

Each adapter normalises a third-party payload into our canonical types (`OrderDTO` for order sources, `PaymentDTO` for gateways).

## Order sources

- [`whatsapp/`](./whatsapp/) — WhatsApp Cloud API → conversational order builder.

> Third-party delivery aggregators (Foodpanda, Careem, etc.) are **not supported**. servd is operator-direct only — GS Foods runs their own delivery fleet via the in-house dispatcher (`backend/src/modules/dispatch/`).

## Payments

- [`payment/`](./payment/) — Generic payment adapter interface.
- [`keenu/`](./keenu/) — Keenu card processor.
- [`jazzcash/`](./jazzcash/) — JazzCash mobile wallet.
- [`easypaisa/`](./easypaisa/) — EasyPaisa wallet.

## Compliance

- [`fbr/`](./fbr/) — Pakistan FBR e-invoice submission adapter.
