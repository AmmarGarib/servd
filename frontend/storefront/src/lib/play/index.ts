// The play layer's public surface. Every package imports from '@/lib/play'.
// Contract: REVIEW.md section 6. Names and signatures are fixed.

export type { StickerId, StickerDef } from './stickers'
export { STICKERS, STICKER_COUNT, STICKER_COLORS, getSticker, isStickerId } from './stickers'

export { usePlay, hydratePlay, localDay, PLAY_STORAGE_KEY } from './store'
export type { PlayState, PlayData, PlayActions } from './store'

export { useHydrated } from './hydrated'
export { collect } from './collect'

export type { Palette, PlayEvent, ToyVerb } from './bus'
export { emitPlay, onPlay, PLAY_EVENT, OPEN_BOOK_EVENT, openStickerBook, TOY_ATTR, TOY_VERBS } from './bus'

export { celebrate, PALETTES } from './celebrate'
export { buzz, sfx, unlockAudio } from './feedback'
export type { SfxName } from './feedback'

export { isQuietRoute, useQuiet, isQuietNow } from './quiet'
export { usePrefersReducedMotion, prefersReducedMotion } from './motion'
export { getScrollVelocity, onScrollFlick } from './scroll'

export { StickerArt } from '../../components/play/StickerArt'
