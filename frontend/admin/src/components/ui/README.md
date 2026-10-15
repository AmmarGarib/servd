# ui

Source files for `frontend/admin/src/components/ui`.

## Files

- `ActivityFeed.tsx` — React component
- `AppShell.tsx` — React component
- `AuthGuard.tsx` — React component
- `EmptyStateGuide.tsx` — React component
- `Providers.tsx` — React component

## Shared primitives (UX audit, 2026-10-15)

One implementation each — a page-local copy is a bug; wrap these instead.

- `Modal.tsx` — `<Modal title onClose wide? dirty? dismissible? footer? labelledBy?>`: portal to body, `role=dialog`
  + `aria-modal` + `aria-labelledby`, `max-h-[90dvh]` with a scrolling body and a sticky `footer`, a 44x44 Close button,
  a backdrop that closes only when mousedown AND mouseup both land on it, and (`dirty`) a "Discard changes?" confirm
  before Escape / backdrop / X. `useDialog(panelRef, { onClose, dismissible?, initialFocusRef? })` is the behaviour alone
  (Escape, Tab trap, initial focus, focus returned to the opener, ref-counted scroll lock on `body` and `main#main`) for
  overlays that keep their own markup (the phone drawer). Only the top-most dialog answers the keyboard.
- `ConfirmDialog.tsx` — `useConfirm()` replaces `window.confirm`:
  `const r = await confirm({ title, body?, confirmLabel?, cancelLabel?, danger?, reason?: { label, minLength } })`
  → `false` or `{ reason? }`. Danger focuses Cancel and Enter does not confirm. `ConfirmProvider` is mounted in `Providers`.
- `PasswordInput.tsx` — input + Show/Hide eye (44px, `aria-pressed`). All input props pass through (keep
  `autoComplete`); `numeric` = PIN (numeric keypad, masked until revealed).
- `NumberField.tsx` — `<NumberField value onValueChange decimals? min? max? allowNegative?>`: typed text kept as a
  string, digits + one dot only, `null` when empty, clamp on blur only, select-all on focus, wheel never edits it.
- `FormField.tsx` — `<FormField label hint? error? required?>{control}</FormField>`: wires id / `htmlFor`,
  `aria-describedby`, `aria-invalid`, `aria-required`; the error is a `role=alert` line.
- `MoneyInput.tsx` — value / onChange stay in cents. Now sanitises while typing (one dot, 2 decimals, commas
  regrouped on blur), selects on focus, takes `id name required aria-invalid aria-describedby onBlur allowNegative`.
- `Select.tsx` — desktop searchable from 4 options; on touch (`pointer: coarse`) native below 8, and the search box
  only takes focus (keyboard) from 12. Positioned from `visualViewport`, closes when the trigger scrolls away.
- Wheel guard: `Providers` blurs a focused `input[type=number]` on any wheel event (capture phase), so scrolling
  never changes a quantity or price. Spinners are hidden in `globals.css`.
- `globals.css`: global `prefers-reduced-motion` block, `touch-action: manipulation`, body text selectable (buttons,
  `nav a`, `.no-select`, canvas/svg are not), 44px shared buttons on `pointer: coarse`.
