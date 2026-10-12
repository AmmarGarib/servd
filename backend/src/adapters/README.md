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

## Fiscal filing (FBR / SRB)

There is **no** tax-authority adapter here, and none may be added. The external
fiscal POS is the ONLY FBR / SRB filer: servd talks to it through the POS
connector in [`../connectors/`](../connectors/) (vendor contract
`docs/pos-connector-api.md`, runbook `docs/TAX_SETUP.md`). The old direct
`fbr/` and `srb/` adapters were removed in the connector cutover; their rules
live on in `connectors/fiscal/payload.ts`.
