# servd hub — Design System MASTER

Global source of truth for the **servd hub** surfaces (home, browse, the servd
nav + footer). Generated with the `ui-ux-pro-max` skill
(`--design-system "restaurant food ordering multi-brand premium" --variance 7
--motion 8 --density 3`) and adapted to the locked servd brand.

**Scope:** the servd hub only. Brand microsites (simmer / stackd / Flipd) keep
their own brand-book art direction — see `CLAUDE.md`. Page-specific overrides
live in `design-system/servd/pages/<page>.md` and win over this file.

## Where the skill's output was overridden, and why

| Skill suggestion | Used instead | Reason |
|---|---|---|
| Palette: appetizing red `#DC2626` + gold on blush | Obsidian plum brand, dark-first (below) | servd's brand is obsidian plum (`CLAUDE.md`); red would also collide with simmer's orange signal |
| Heading: Playfair Display SC | Playfair Display (upright + italic) | Small caps read as a menu card; the hub needs headline range. Same family, already loaded |
| Motion via GSAP Flip | framer-motion (already a dependency) | No new animation runtime; same timing/easing contract |
| Pattern: 3-step funnel | Hero-Centric + **Bento Grid Showcase** | Second skill query; the hub sells three kitchens, not one conversion path |

Kept from the skill as-is: the dark-premium + tactile-depth style direction,
Inter body, spacious density, the motion contract, every UX/a11y rule.

## Pattern — Hero-Centric + Bento Grid Showcase

Section order (home): **Hero → Bento (the three kitchens) → Right-now status
→ Insiders → closing CTA (footer)**. Scannable value props, high information
density without clutter; the grid stacks to one column on mobile. Cards stay
fully usable without hover. Primary CTA appears in the hero and at the bottom
of every major section.

## Style — Dark premium, tactile

Deep obsidian ground, warm lit surfaces, film grain, multi-layer soft shadows,
tactile press states (scale 0.97, 300ms). Photography leads; chrome recedes.
Glow is used sparingly — lilac for interaction, ember for appetite.

## Color tokens (dark-first) — all text pairs verified WCAG AA

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--hub-bg` | `#110B13` | Page ground | — |
| `--hub-bg-raised` | `#171019` | Alternating section ground | — |
| `--hub-surface` | `#211824` | Cards, panels | — |
| `--hub-surface-2` | `#2A1F2D` | Hover / nested surface | — |
| `--hub-line` | `rgba(255,255,255,0.08)` | Hairlines | decorative |
| `--hub-line-strong` | `rgba(255,255,255,0.16)` | Card borders | decorative |
| `--hub-text` | `#F4EEF3` | Primary text | 16.99:1 on bg |
| `--hub-text-mute` | `#B8AAB9` | Body / secondary | 8.78:1 bg · 7.77:1 surface |
| `--hub-text-dim` | `#9A8B9C` | Meta, captions (≥14px) | 6.06:1 bg · 5.36:1 surface |
| `--hub-plum` | `#4E2A4F` | Brand fill, badges (white text) | white on plum 11.88:1 |
| `--hub-lilac` | `#C9A4F2` | Primary CTA fill, links, focus | 9.32:1 on bg |
| `--hub-on-lilac` | `#110B13` | Text on lilac CTA | 9.32:1 |
| `--hub-ember` | `#E8955F` | Appetite accent, "open now" warmth | 8.23:1 on bg |
| `--hub-open` | `#7BD88F` | Live/open status (always paired with a text label) | — |

Never convey state with color alone — every status has a text label.

## Typography

- **Display:** Playfair Display 600–800, italic for the emotional half of a
  headline. `letter-spacing: -0.02em`, `line-height: 1.02`.
- **Body:** Inter 400/500, **16px base, line-height 1.6**, max 68ch.
- **Eyebrow:** Inter 600, 0.75rem, uppercase, `letter-spacing: 0.22em`.
- Scale: 12 · 14 · 16 · 18 · 22 · 28 · 36 · 48 · 64 · 88 (fluid via clamp).
- No body text below 14px; meta text ≥ 12px only in uppercase eyebrows.

## Spacing (density 3 — spacious)

`--hub-space`: 8 · 16 · 24 · 32 · 48 · 64 · 96 · 128. Sections: 96–128px
vertical on desktop, 64px mobile. Card padding 24–32px. Grid gap 16–24px.

## Radius & elevation

Cards `20px`, pills `999px`, inputs `14px`.
Shadow (surface): `0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -12px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.35)`.

## Motion (dial 8 — complex choreography, restrained per element)

| Kind | Duration | Easing |
|---|---|---|
| Micro (hover, press, focus) | 180–260ms | `cubic-bezier(0.22,1,0.36,1)` |
| Section reveal | 600–800ms | `cubic-bezier(0.16,1,0.3,1)` (expo-out) |
| Stagger step | 80ms | — |
| Exit | ~70% of enter | exits faster than enters |

Animate `transform`/`opacity` only — never width/height/top. Motion must mean
something (entrance order = reading order). **`prefers-reduced-motion`:**
render final states immediately, pause video/scrubbing, no parallax.

## Interaction & UX rules (skill priorities 1–9)

1. Contrast ≥ 4.5:1 text, ≥ 3:1 UI boundaries; visible focus ring
   (2px lilac, 3px offset) on every interactive element.
2. Touch targets ≥ 44×44px, ≥ 8px apart; `cursor: pointer` on clickables.
3. Reserve media space (aspect-ratio) — CLS < 0.1; lazy-load below the fold.
4. SVG icons only (Lucide) — **never emoji** (also a `CLAUDE.md` rule).
5. Mobile-first; verify 375 · 768 · 1024 · 1440. No horizontal scroll.
6. Semantic tokens only in components — no raw hex outside this file/globals.
7. Hover is an enhancement, never the only path to an action.
8. Forms: visible labels, error next to the field, helper text.
9. Predictable navigation: back works, every section deep-linkable.

## Anti-patterns (from the skill + servd rules)

Low-quality imagery · outdated hours · emoji icons · placeholder-only labels ·
color-only status · instant (0ms) state changes · one duration for everything ·
animating layout properties · capital-S "Simmer" · third-party aggregator
messaging.

## Pre-delivery checklist

- [ ] No emoji as icons (SVG / Lucide)
- [ ] `cursor-pointer` + hover/press states (150–300ms) on all clickables
- [ ] Text contrast ≥ 4.5:1; focus visible on keyboard nav
- [ ] `prefers-reduced-motion` respected (final states, no scrub/parallax)
- [ ] Responsive at 375 / 768 / 1024 / 1440, no horizontal scroll
- [ ] Media has reserved aspect-ratio; below-fold images lazy
- [ ] Brand rules: lowercase `simmer`, lowercase `stackd`
