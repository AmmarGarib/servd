# frontend/admin

Operations portal — Next.js 14 (App Router) + Tailwind + React Query + Zustand.

## Stack

- Next.js App Router (server components by default, `'use client'` opt-in).
- Tailwind for styling. Custom palette in `tailwind.config.ts` — see the `s-*` (general) and `kds-*` (Kitchen Display) colour tokens.
- TanStack Query for server state, Zustand for client state (cart, KDS lang, POS shift).
- next-intl for English / اردو bilingual UI.
- Sentry for error tracking.

## Layout

- [`src/app/`](./src/app/) — App Router pages. One folder per route segment.
- [`src/components/`](./src/components/) — Shared React components (KDS ticket card, AppShell sidebar, dashboard widgets).
- [`src/hooks/`](./src/hooks/) — Custom hooks (`useKdsSocket`, `useCan`, `useKdsVoice`).
- [`src/lib/`](./src/lib/) — API client, formatting helpers, socket factory.
- [`src/store/`](./src/store/) — Zustand stores (auth, KDS prefs, POS cart).
- [`src/i18n/`](./src/i18n/) — next-intl request configuration.
- [`messages/`](./messages/) — Translation JSON (`en.json`, `ur.json`).
- [`public/`](./public/) — Static assets + service worker (`sw.js`).

## Run

```
npm run dev      # http://localhost:3000
npm run build
npm run lint
```

## Backend dependency

Set `NEXT_PUBLIC_API_URL=http://localhost:3001` in `.env.local`. The backend must be running before staff can sign in.
