'use client';

// Scroll-expansion hero. Adapted for servd from the shadcn-style
// `scroll-expansion-hero` block:
//   - uses plain <img>/<video> instead of next/image so the background and
//     media can be ANY operator-supplied URL (R2, Unsplash, YouTube, …) without
//     tripping next/image's remotePatterns allow-list.
//   - title/labels use white (over the dark-overlaid food background) instead
//     of the demo's blue.
// The scroll behaviour is unchanged: the media expands as you scroll, then the
// page releases into normal scroll once fully expanded. On top of it:
//   - the title is ONE heading (h1 by default) holding the two sliding halves,
//     so the page outline reads "Every kitchen. One order." as one line.
//   - first paint is the expanded-from state: the purple background paints at
//     full opacity from the server HTML, and the media box takes its phone /
//     desktop size from CSS (no jump when the isMobile check lands).
//   - the wheel / touchmove listeners that hold the page still are only
//     attached while the hero is in play (collapsed, or expanded with the page
//     at the very top, where scrolling up collapses it again). Once the visitor
//     scrolls into the page there is nothing blocking the compositor.
//   - PageDown / Space / ArrowDown / End expand it (the snap-back used to trap
//     keyboard users at the top), and prefers-reduced-motion renders it
//     expanded with no scroll hijack.
//   - the video never preloads: it is rendered without a source, which is
//     attached (and played) after hydration once the browser is idle — and
//     never played under reduced motion or Save-Data, where the poster stands
//     in (with no poster set, a still of the first frame does).
//   - until there is something to see in the box, the servd Loader sits in it
//     (under the title) and fades out once the video plays / the still or the
//     YouTube player loads, or it fails; a poster on a file video stands in instead.
// No framer-motion: the three fades are CSS opacity transitions with the same
// durations and curve framer used (ease-in-out; 0.1s / 0.2s / 0.7s).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader } from './Loader';

type HeadingLevel = 'h1' | 'h2';
type MediaMode = 'none' | 'play' | 'still';

interface ScrollExpandMediaProps {
  mediaType?: 'video' | 'image';
  mediaSrc: string;
  posterSrc?: string;
  bgImageSrc: string;
  /** Photos behind the media, cross-faded one after another. Empty = bgImageSrc alone. */
  bgSlides?: BgSlide[];
  /** Seconds each photo shows (3–15). */
  bgSlideSeconds?: number;
  title?: string;
  /** The title's tag. One h1 per page: use h2 when the page has its own h1. */
  headingLevel?: HeadingLevel;
  /** What the expanding video/photo shows. Empty = decorative. */
  mediaAlt?: string;
  date?: string;
  scrollToExpand?: string;
  textBlend?: boolean;
  children?: ReactNode;
  /** false = nothing visible after the expansion (only an sr-only heading): no padded reveal band. */
  revealPadded?: boolean;
  /** servd logo mark centred above the media box (fades out as it opens). Empty = none. */
  logoSrc?: string;
  logoAlt?: string;
  /** Small animated chevron at the foot of the first screen, until the visitor scrolls. */
  scrollCue?: boolean;
}

export interface BgSlide { src: string; alt: string }

/**
 * The background slideshow: photos cross-fade (1 s) one after another. Only
 * the photo on show and the NEXT one are loaded (each stays mounted once seen,
 * so the fade-out works); the first is the page's LCP image and loads eagerly.
 * Paused while the tab is hidden or the media is fully open; reduced motion
 * or a single photo = the first photo, no timer.
 */
function BgSlideshow({ slides, seconds, paused }: { slides: BgSlide[]; seconds: number; paused: boolean }) {
  const [index, setIndex] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([0]));
  const count = slides.length;
  const current = count ? index % count : 0;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const cycling = count > 1 && !reduced;
  const next = (current + 1) % Math.max(count, 1);

  useEffect(() => {
    if (!cycling) return;
    setSeen((prev) => (prev.has(current) && prev.has(next) ? prev : new Set([...prev, current, next])));
  }, [cycling, current, next]);

  useEffect(() => {
    if (!cycling || paused) return;
    const t = setInterval(() => {
      if (!document.hidden) setIndex((i) => (i + 1) % count);
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [cycling, paused, seconds, count]);

  return (
    <>
      {slides.map((s, i) => {
        if (i !== current && !(cycling && seen.has(i))) return null;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${i}:${s.src}`}
            src={s.src}
            alt={s.alt}
            {...(!s.alt && { 'aria-hidden': true })}
            loading={i === 0 ? 'eager' : 'lazy'}
            {...(i === 0 && { fetchPriority: 'high' as const })}
            decoding='async'
            className='absolute inset-0 w-screen h-screen object-cover'
            style={{ objectPosition: 'center', opacity: i === current ? 1 : 0, transition: 'opacity 1s ease-in-out' }}
          />
        );
      })}
    </>
  );
}

const YT_PARAMS = 'autoplay=1&mute=1&loop=1&controls=0&showinfo=0&rel=0&disablekb=1&modestbranding=1';

/** Loader cells for the purple box: green → bone along the ripple's diagonal
 *  (the default purple → green ramp would vanish into the purple). */
const HERO_LOADER_CELLS = [
  'var(--servd-green)', 'var(--servd-green)', 'var(--servd-green-soft)',
  'var(--servd-green)', 'var(--servd-green-soft)', 'var(--servd-on-purple)',
  'var(--servd-green-soft)', 'var(--servd-on-purple)', 'var(--servd-on-purple)',
];

/** How long the one-off expansion takes — the same on every device. */
const EXPAND_MS = 1100;

/** Keys that scroll the page down — they expand the hero instead. */
const EXPAND_KEYS = new Set(['PageDown', ' ', 'Spacebar', 'ArrowDown', 'End']);

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function saveDataOn(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

/** A key press aimed at a dialog (the search sheet, a pop-up) scrolls that
 *  dialog, and while a modal is open the page behind it must not move. */
function isDialogKey(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('[role="dialog"],[aria-modal="true"]')) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** A key press aimed at a field or a control, not at the page. */
function isTypingTarget(target: EventTarget | null, key: string): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // Space activates a focused button / link / summary.
  return (key === ' ' || key === 'Spacebar') && (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || el.getAttribute('role') === 'button');
}

const ScrollExpandMedia = ({
  mediaType = 'video',
  mediaSrc,
  posterSrc,
  bgImageSrc,
  bgSlides,
  bgSlideSeconds = 6,
  title,
  headingLevel = 'h1',
  mediaAlt = '',
  date,
  scrollToExpand,
  textBlend,
  children,
  revealPadded = true,
  logoSrc,
  logoAlt = '',
  scrollCue = true,
}: ScrollExpandMediaProps) => {
  const [scrollProgress, setScrollProgress] = useState<number>(0);
  // The slideshow, or the single background photo as a one-photo slideshow.
  const slides: BgSlide[] = bgSlides?.length ? bgSlides : bgImageSrc ? [{ src: bgImageSrc, alt: '' }] : [];
  const [showContent, setShowContent] = useState<boolean>(false);
  const [mediaFullyExpanded, setMediaFullyExpanded] = useState<boolean>(false);
  const [isMobileState, setIsMobileState] = useState<boolean>(false);
  // The visitor has made their one scroll / swipe: the expansion is playing.
  const [started, setStarted] = useState<boolean>(false);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  // After hydration: lets the media overlays run the fade they always ran.
  const [hydrated, setHydrated] = useState<boolean>(false);
  // What the video / YouTube slot may load once the browser is idle: nothing
  // yet, the playing loop, or (less motion / less data, and no poster to
  // stand in) a still of the first frame.
  const [mediaMode, setMediaMode] = useState<MediaMode>('none');
  // The video / YouTube slot shows what it is going to show: playing, its
  // still painted, the player loaded — or it failed. Ends the loader.
  const [mediaSettled, setMediaSettled] = useState<boolean>(false);

  const sectionRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isYouTube = mediaType === 'video' && mediaSrc.includes('youtube.com');

  // A jump far down the page (an "Order" link to #kitchens, or arriving on
  // /home#kitchens) means the visitor wants the content, not the animation:
  // finish the expansion and stay there. So does reduced motion.
  const expandNow = (): void => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    startedRef.current = true;
    expandedRef.current = true;
    setStarted(true);
    setScrollProgress(1);
    setMediaFullyExpanded(true);
    setShowContent(true);
  };

  // UX-1 (owner, 2026-10-16): the page scrolls natively — no wheel / touch
  // hijacking. The first scroll, swipe or key press (seen by PASSIVE
  // listeners) plays the expansion ONCE, over a fixed time with one easing,
  // so it feels the same on a mouse wheel, a trackpad and a phone. Once open
  // it stays open: scrolling back to the top never replays it. While it is
  // still closed the document does not scroll (overflow hidden, below), so
  // the gesture cannot move the page under the animation.
  useEffect(() => {
    const reduce = prefersReducedMotion();
    setReducedMotion(reduce);
    if (reduce) expandNow();
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rafRef = useRef(0);
  const startedRef = useRef(false);
  const expandedRef = useRef(false);

  const play = (): void => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStarted(true);
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - t0) / EXPAND_MS, 1);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setScrollProgress(eased);
      if (eased >= 0.75) setShowContent(true);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
        expandedRef.current = true;
        setMediaFullyExpanded(true);
        setShowContent(true);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // While closed the page is held at the top with CSS, not with event
  // cancelling. Smooth anchor scrolling (globals.css) is off meanwhile so a
  // jump to #kitchens lands at once and can finish the expansion.
  useEffect(() => {
    if (reducedMotion || mediaFullyExpanded) return;
    const root = document.documentElement;
    root.style.overflow = 'hidden';
    root.style.scrollBehavior = 'auto';
    return () => {
      root.style.removeProperty('overflow');
      root.style.removeProperty('scroll-behavior');
    };
  }, [reducedMotion, mediaFullyExpanded]);

  useEffect(() => {
    if (reducedMotion || mediaFullyExpanded) return;
    const onScroll = (): void => {
      if (window.scrollY > window.innerHeight * 0.5) { expandNow(); return; }
      if (window.scrollY > 0) { window.scrollTo(0, 0); play(); }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!EXPAND_KEYS.has(e.key)) return;
      if ((e.key === ' ' || e.key === 'Spacebar') && e.shiftKey) return;
      if (isTypingTarget(e.target, e.key)) return;
      if (isDialogKey(e.target)) return;
      if (e.key === 'End') expandNow(); else play();
    };
    const onWheel = (e: WheelEvent): void => { if (e.deltaY > 0) play(); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent): void => { touchY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? 0;
      if (touchY - y > 8) play(); // finger moving up = scrolling down
    };
    if (window.scrollY > window.innerHeight * 0.5) expandNow();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKey);
    };
    // play / expandNow only touch refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, mediaFullyExpanded]);

  useEffect(() => {
    const checkIfMobile = (): void => {
      setIsMobileState(window.innerWidth < 768);
    };

    checkIfMobile();
    window.addEventListener('resize', checkIfMobile);

    return () => window.removeEventListener('resize', checkIfMobile);
  }, []);

  // Video: never on the critical path. Once hydrated and the browser is idle,
  // let the source load — unless the visitor asked for less motion or less
  // data. Then the poster is all they get; with no poster, a still of the
  // first frame stands in (metadata only, never played) so the panel is not
  // an empty box — reduced motion renders it expanded, title off-screen.
  useEffect(() => {
    setMediaMode('none');
    setMediaSettled(false);
    if (mediaType !== 'video' || !mediaSrc) return;
    const still = prefersReducedMotion() || saveDataOn();
    if (still && posterSrc) return;
    const go = () => setMediaMode(still ? 'still' : 'play');
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(go, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(go, 200);
    return () => window.clearTimeout(t);
  }, [mediaType, mediaSrc, posterSrc]);

  // Attach the file: play it (muted, so autoplay policy allows it), or for a
  // still load just enough to paint the first frame — the #t fragment makes
  // iOS Safari paint it without play().
  useEffect(() => {
    const v = videoRef.current;
    if (!v || mediaMode === 'none' || isYouTube) return;
    let live = true;
    v.muted = true;
    if (mediaMode === 'still') {
      v.preload = 'metadata';
      v.src = mediaSrc.includes('#') ? mediaSrc : `${mediaSrc}#t=0.001`;
    } else {
      v.src = mediaSrc;
      // Autoplay refused (e.g. low-power mode): the poster stays, and nothing
      // more is coming, so the loader goes too.
      v.play().catch(() => { if (live) setMediaSettled(true); });
    }
    return () => {
      live = false;
      v.pause();
      v.removeAttribute('src');
      v.preload = 'none';
      v.load();
      setMediaSettled(false);
    };
  }, [mediaMode, mediaSrc, isYouTube]);

  // On phones the screen is portrait but the media is landscape (16:9): a tall
  // box + object-cover zooms hard into the centre. Keep the mobile box wide and
  // short (≈16:9 at full expand) so the whole frame stays visible instead of
  // cropping. Desktop is unchanged (its box already lands ~16:9 within 95vw/85vh).
  const mediaWidth = 300 + scrollProgress * (isMobileState ? 650 : 1250);
  const mediaHeight = (isMobileState ? 200 : 400) + scrollProgress * (isMobileState ? 20 : 400);
  const textTranslateX = scrollProgress * (isMobileState ? 180 : 150);
  // At rest the box is sized by CSS (300x200 on phones, 300x400 from md), so
  // the server HTML already has the right size; JS takes over once it moves.
  const boxSized = scrollProgress > 0;

  const firstWord = title ? (title.split(' ')[0] ?? '') : '';
  const restOfTitle = title ? title.split(' ').slice(1).join(' ') : '';
  const Heading = headingLevel === 'h2' ? 'h2' : 'h1';

  // The overlays start at 0.7 and settle to their scroll value after
  // hydration, as the framer version did (0.2s).
  const videoOverlayOpacity = hydrated ? 0.5 - scrollProgress * 0.3 : 0.7;
  const imageOverlayOpacity = 0.7 - scrollProgress * 0.3;
  const overlayTransition = 'opacity 200ms ease-in-out';

  // A YouTube slot that is not playing shows the poster; with none, a still
  // (less motion / less data) shows the video's own thumbnail.
  const youTubeId = isYouTube ? (mediaSrc.match(/(?:embed\/|[?&]v=)([\w-]{11})/)?.[1] ?? '') : '';
  const youTubeStill = posterSrc
    || (mediaMode === 'still' && youTubeId ? `https://i.ytimg.com/vi/${youTubeId}/hqdefault.jpg` : '');

  // The loader holds the box while a video is on its way and nothing stands in
  // for it. A poster on a file video is that stand-in (and the final picture
  // under less motion / less data), so it gets none; a YouTube poster gives
  // way to the player, so the loader covers the player while it boots. Same
  // answer on the server, so it is in the first paint.
  const posterStandsIn = !!posterSrc && !(isYouTube && mediaMode === 'play');
  const nothingComing = isYouTube && mediaMode === 'still' && !youTubeStill;
  const showLoader = mediaType === 'video' && !!mediaSrc && !posterStandsIn && !nothingComing && !mediaSettled;
  // Kept mounted through its 300ms fade-out, then dropped (its ripple never stops).
  const [loaderMounted, setLoaderMounted] = useState<boolean>(showLoader);
  useEffect(() => {
    if (showLoader) {
      setLoaderMounted(true);
      return;
    }
    const t = window.setTimeout(() => setLoaderMounted(false), 300);
    return () => window.clearTimeout(t);
  }, [showLoader]);
  const settleMedia = (): void => setMediaSettled(true);

  const mediaA11y = mediaAlt
    ? { 'aria-label': mediaAlt }
    : { 'aria-hidden': true as const };

  return (
    <div
      ref={sectionRef}
      className='transition-colors duration-700 ease-in-out overflow-x-hidden'
    >
      <section className='relative flex flex-col items-center justify-start min-h-[100dvh]'>
        <div className='relative w-full flex flex-col items-center min-h-[100dvh]'>
          <div
            className='absolute inset-0 z-0 h-full'
            style={{ opacity: 1 - scrollProgress, transition: 'opacity 100ms ease-in-out' }}
          >
            {slides.length ? (
              // Behind the title; the whole layer fades out as the media opens.
              <div className='relative w-screen h-screen'>
                <BgSlideshow slides={slides} seconds={Math.min(15, Math.max(3, bgSlideSeconds))} paused={mediaFullyExpanded} />
              </div>
            ) : (
              <div aria-hidden='true' className='w-screen h-screen' style={{ background: 'var(--servd-purple)' }} />
            )}
            {/* The dimming film is for photo backgrounds only — over the plain
                token purple it turned #5a2156 into a muddier #511e4d. */}
            {slides.length > 0 && <div className='absolute inset-0 bg-black/10' />}
          </div>

          <div className='container mx-auto flex flex-col items-center justify-start relative z-10'>
            <div className='flex flex-col items-center justify-center w-full h-[100dvh] relative'>
              {logoSrc && (
                <div
                  className={`absolute z-10 left-1/2 -translate-x-1/2 pointer-events-none${
                    boxSized ? '' : ' bottom-[calc(50%+100px+1rem)] md:bottom-[calc(50%+200px+1rem)]'
                  }`}
                  style={{
                    ...(boxSized && { bottom: `calc(50% + ${Math.min(mediaHeight, typeof window === 'undefined' ? mediaHeight : window.innerHeight * 0.85) / 2}px + 1rem)` }),
                    opacity: Math.max(0, 1 - scrollProgress * 3),
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logoSrc}
                    alt={logoAlt}
                    {...(!logoAlt && { 'aria-hidden': true })}
                    width={192}
                    height={192}
                    decoding='async'
                    className='h-14 w-14 md:h-16 md:w-16 rounded-2xl bg-white p-1.5 shadow-lg'
                  />
                </div>
              )}
              <div
                className={`absolute z-0 top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 transition-none rounded-2xl${
                  boxSized ? '' : ' w-[300px] h-[200px] md:h-[400px]'
                }`}
                style={{
                  ...(boxSized && { width: `${mediaWidth}px`, height: `${mediaHeight}px` }),
                  maxWidth: '95vw',
                  maxHeight: '85vh',
                  boxShadow: '0px 0px 50px rgba(0, 0, 0, 0.3)',
                }}
              >
                {mediaType === 'video' ? (
                  isYouTube ? (
                    // Purple under the media: the box itself is transparent, and once the
                    // hero opens the purple layer behind it fades to the page's bone —
                    // the loader's light cells (and an empty or failed box) need the
                    // purple to read. The video / player covers it once it paints.
                    <div className='relative w-full h-full pointer-events-none rounded-xl' style={{ background: 'var(--servd-purple)' }}>
                      {mediaMode === 'play' ? (
                        <iframe
                          width='100%'
                          height='100%'
                          src={
                            mediaSrc.includes('embed')
                              ? mediaSrc + (mediaSrc.includes('?') ? '&' : '?') + YT_PARAMS
                              : mediaSrc.replace('watch?v=', 'embed/') +
                                '?' + YT_PARAMS + '&playlist=' +
                                (mediaSrc.split('v=')[1] ?? '')
                          }
                          title={mediaAlt || 'Video'}
                          className='w-full h-full rounded-xl'
                          frameBorder='0'
                          allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
                          allowFullScreen
                          onLoad={settleMedia}
                        />
                      ) : youTubeStill ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={youTubeStill}
                          alt={mediaAlt}
                          {...(!mediaAlt && { 'aria-hidden': true })}
                          className='w-full h-full object-cover rounded-xl'
                          {...(mediaMode === 'still' && { onLoad: settleMedia, onError: settleMedia })}
                        />
                      ) : null}
                      <div
                        className='absolute inset-0 z-10'
                        style={{ pointerEvents: 'none' }}
                      ></div>

                      <div
                        className='absolute inset-0 bg-black/30 rounded-xl'
                        style={{ opacity: videoOverlayOpacity, transition: overlayTransition }}
                      />
                    </div>
                  ) : (
                    <div className='relative w-full h-full pointer-events-none rounded-xl' style={{ background: 'var(--servd-purple)' }}>
                      {/* No src until the browser is idle (see mediaMode). */}
                      <video
                        ref={videoRef}
                        poster={posterSrc}
                        muted
                        loop
                        playsInline
                        preload='none'
                        className='w-full h-full object-cover rounded-xl'
                        controls={false}
                        disablePictureInPicture
                        disableRemotePlayback
                        {...mediaA11y}
                        onPlaying={settleMedia}
                        onLoadedData={(e) => {
                          if (mediaMode === 'still' || !e.currentTarget.paused) settleMedia();
                        }}
                        onError={settleMedia}
                      />
                      <div
                        className='absolute inset-0 z-10'
                        style={{ pointerEvents: 'none' }}
                      ></div>

                      <div
                        className='absolute inset-0 bg-black/30 rounded-xl'
                        style={{ opacity: videoOverlayOpacity, transition: overlayTransition }}
                      />
                    </div>
                  )
                ) : (
                  <div className='relative w-full h-full'>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaSrc}
                      alt={mediaAlt}
                      className='w-full h-full object-cover rounded-xl'
                    />

                    <div
                      className='absolute inset-0 bg-black/50 rounded-xl'
                      style={{ opacity: imageOverlayOpacity, transition: overlayTransition }}
                    />
                  </div>
                )}

                {/* The title is centred over the box, so the loader takes the
                    band under it (centred when there is no title): 42px on
                    phones (200px box), 66px from md (400px box). Decorative
                    media keeps it out of the accessibility tree. */}
                {(showLoader || loaderMounted) && (
                  <div
                    className={`absolute z-20 flex items-center justify-center pointer-events-none ${
                      title ? 'inset-x-0 bottom-0 h-[28%]' : 'inset-0'
                    }`}
                    style={{ opacity: showLoader ? 1 : 0, transition: 'opacity 300ms ease-in-out' }}
                    {...(!mediaAlt && { 'aria-hidden': true })}
                  >
                    <Loader size={20} colors={HERO_LOADER_CELLS} className='scale-[0.64] md:scale-100' />
                  </div>
                )}

                <div className='flex flex-col items-center text-center relative z-10 mt-4 transition-none'>
                  {date && (
                    <p
                      className='text-base sm:text-2xl text-white/80 drop-shadow'
                      style={{ transform: `translateX(-${textTranslateX}vw)` }}
                    >
                      {date}
                    </p>
                  )}
                  {scrollToExpand && (
                    <p
                      className='text-white/80 font-medium text-center'
                      style={{ transform: `translateX(${textTranslateX}vw)` }}
                    >
                      {scrollToExpand}
                    </p>
                  )}
                </div>
              </div>

              {/* One heading, two halves: the first word slides left, the rest
                  right. The space between the halves is not rendered (flex) but
                  keeps the heading's text "Every kitchen. One order.". The
                  letter-spacing is the h2 rhythm the halves always had, and it
                  sits on the halves themselves: an em letter-spacing resolves
                  on the element that declares it, so declared on the heading
                  (body size) it would inherit as ~-0.3px instead of scaling
                  with each half's own text size. */}
              {title && (
                <Heading
                  className={`flex items-center justify-center text-center gap-4 w-full relative z-10 transition-none flex-col ${
                    textBlend ? 'mix-blend-difference' : 'mix-blend-normal'
                  }`}
                >
                  <span
                    className='text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white drop-shadow-lg transition-none'
                    style={{ letterSpacing: '-0.02em', transform: `translateX(-${textTranslateX}vw)` }}
                  >
                    {firstWord}
                  </span>{' '}
                  <span
                    className='text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-center text-white drop-shadow-lg transition-none'
                    style={{ letterSpacing: '-0.02em', transform: `translateX(${textTranslateX}vw)` }}
                  >
                    {restOfTitle}
                  </span>
                </Heading>
              )}
            {scrollCue && !started && !reducedMotion && (
              <div
                aria-hidden='true'
                className='absolute z-10 left-1/2 -translate-x-1/2 bottom-6 text-white/90 animate-bounce motion-reduce:animate-none'
                style={{ opacity: hydrated ? 1 : 0, transition: 'opacity 400ms ease-in-out' }}
              >
                <svg width='28' height='28' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round' strokeLinejoin='round' className='drop-shadow-lg'>
                  <path d='M6 9l6 6 6-6' />
                </svg>
              </div>
            )}
            </div>

            <section
              className={revealPadded ? 'flex flex-col w-full px-8 py-10 md:px-16 lg:py-20' : 'flex flex-col w-full'}
              style={{ opacity: showContent ? 1 : 0, transition: 'opacity 700ms ease-in-out' }}
            >
              {children}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
};

export default ScrollExpandMedia;
