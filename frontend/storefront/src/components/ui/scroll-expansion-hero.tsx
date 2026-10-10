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
// No framer-motion: the three fades are CSS opacity transitions with the same
// durations and curve framer used (ease-in-out; 0.1s / 0.2s / 0.7s).

import { useEffect, useRef, useState, type ReactNode } from 'react';

type HeadingLevel = 'h1' | 'h2';
type MediaMode = 'none' | 'play' | 'still';

interface ScrollExpandMediaProps {
  mediaType?: 'video' | 'image';
  mediaSrc: string;
  posterSrc?: string;
  bgImageSrc: string;
  title?: string;
  /** The title's tag. One h1 per page: use h2 when the page has its own h1. */
  headingLevel?: HeadingLevel;
  /** What the expanding video/photo shows. Empty = decorative. */
  mediaAlt?: string;
  date?: string;
  scrollToExpand?: string;
  textBlend?: boolean;
  children?: ReactNode;
}

const YT_PARAMS = 'autoplay=1&mute=1&loop=1&controls=0&showinfo=0&rel=0&disablekb=1&modestbranding=1';

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
  title,
  headingLevel = 'h1',
  mediaAlt = '',
  date,
  scrollToExpand,
  textBlend,
  children,
}: ScrollExpandMediaProps) => {
  const [scrollProgress, setScrollProgress] = useState<number>(0);
  const [showContent, setShowContent] = useState<boolean>(false);
  const [mediaFullyExpanded, setMediaFullyExpanded] = useState<boolean>(false);
  const [touchStartY, setTouchStartY] = useState<number>(0);
  const [isMobileState, setIsMobileState] = useState<boolean>(false);
  // The document is at (or within 5px of) the top — where scrolling up on an
  // expanded hero collapses it again.
  const [atTop, setAtTop] = useState<boolean>(true);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  // After hydration: lets the media overlays run the fade they always ran.
  const [hydrated, setHydrated] = useState<boolean>(false);
  // What the video / YouTube slot may load once the browser is idle: nothing
  // yet, the playing loop, or (less motion / less data, and no poster to
  // stand in) a still of the first frame.
  const [mediaMode, setMediaMode] = useState<MediaMode>('none');

  const sectionRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isYouTube = mediaType === 'video' && mediaSrc.includes('youtube.com');

  // A jump far down the page (an "Order" link to #kitchens, or arriving on
  // /home#kitchens) means the visitor wants the content, not the animation:
  // finish the expansion and stay there. So does reduced motion.
  const expandNow = (): void => {
    setScrollProgress(1);
    setMediaFullyExpanded(true);
    setShowContent(true);
  };

  useEffect(() => {
    const reduce = prefersReducedMotion();
    setReducedMotion(reduce);
    if (reduce) {
      expandNow();
      return;
    }
    setScrollProgress(0);
    setShowContent(false);
    setMediaFullyExpanded(false);
  }, [mediaType]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  // Scroll: small scrolls (scrollbar) snap back so the hero plays; a big jump
  // finishes it. Also tracks "at the top" for the listeners below. A scroll
  // listener never blocks scrolling, so it stays for the life of the hero.
  useEffect(() => {
    const handleScroll = (): void => {
      setAtTop(window.scrollY <= 5);
      if (mediaFullyExpanded) return;
      if (window.scrollY > window.innerHeight * 0.5) expandNow();
      else window.scrollTo(0, 0);
    };
    if (!mediaFullyExpanded && window.scrollY > window.innerHeight * 0.5) expandNow();
    setAtTop(window.scrollY <= 5);

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [mediaFullyExpanded]);

  // Where a touch started. Passive: these never cancel anything.
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) setTouchStartY(t.clientY);
    };
    const handleTouchEnd = (): void => {
      setTouchStartY(0);
    };
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  // Wheel / touchmove drive the expansion and must cancel the native scroll,
  // so they cannot be passive. They are attached only while the hero is in
  // play: collapsed, or expanded with the page at the top (scrolling up there
  // collapses it). Reading the page below, nothing blocks scrolling.
  const heroInPlay = !reducedMotion && (!mediaFullyExpanded || atTop);
  useEffect(() => {
    if (!heroInPlay) return;

    const handleWheel = (e: WheelEvent) => {
      if (mediaFullyExpanded && e.deltaY < 0 && window.scrollY <= 5) {
        setMediaFullyExpanded(false);
        e.preventDefault();
      } else if (!mediaFullyExpanded) {
        e.preventDefault();
        const scrollDelta = e.deltaY * 0.0009;
        const newProgress = Math.min(
          Math.max(scrollProgress + scrollDelta, 0),
          1
        );
        setScrollProgress(newProgress);

        if (newProgress >= 1) {
          setMediaFullyExpanded(true);
          setShowContent(true);
        } else if (newProgress < 0.75) {
          setShowContent(false);
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStartY) return;

      const t = e.touches[0];
      if (!t) return;
      const touchY = t.clientY;
      const deltaY = touchStartY - touchY;

      // Pull-to-refresh escape hatch. deltaY < 0 means the finger is moving
      // DOWN — the browser's refresh gesture. When the hero is collapsed at
      // progress 0 and the document is at the top, there is no animation left
      // to reverse (newProgress is clamped at 0 below), so calling
      // preventDefault() here would swallow the gesture for no benefit and the
      // page could never be pull-to-refreshed on mobile. Bail out and let the
      // browser have it.
      if (deltaY < 0 && !mediaFullyExpanded && scrollProgress <= 0 && window.scrollY <= 0) {
        return;
      }

      if (mediaFullyExpanded && deltaY < -20 && window.scrollY <= 5) {
        setMediaFullyExpanded(false);
        e.preventDefault();
      } else if (!mediaFullyExpanded) {
        e.preventDefault();
        // Increase sensitivity for mobile, especially when scrolling back
        const scrollFactor = deltaY < 0 ? 0.008 : 0.005; // Higher sensitivity for scrolling back
        const scrollDelta = deltaY * scrollFactor;
        const newProgress = Math.min(
          Math.max(scrollProgress + scrollDelta, 0),
          1
        );
        setScrollProgress(newProgress);

        if (newProgress >= 1) {
          setMediaFullyExpanded(true);
          setShowContent(true);
        } else if (newProgress < 0.75) {
          setShowContent(false);
        }

        setTouchStartY(touchY);
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, [heroInPlay, scrollProgress, mediaFullyExpanded, touchStartY]);

  // Keyboard: the keys that scroll down expand the hero (the snap-back above
  // used to leave keyboard users stuck at scrollY 0). End also lets the
  // browser jump to the end, which the scroll handler then keeps expanded.
  // Keys inside the search sheet or a pop-up (or with a modal open) are left
  // alone: they scroll the dialog, not the page behind it.
  useEffect(() => {
    if (reducedMotion || mediaFullyExpanded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!EXPAND_KEYS.has(e.key)) return;
      if ((e.key === ' ' || e.key === 'Spacebar') && e.shiftKey) return;
      if (isTypingTarget(e.target, e.key)) return;
      if (isDialogKey(e.target)) return;
      if (e.key !== 'End') e.preventDefault();
      expandNow();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
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
    v.muted = true;
    if (mediaMode === 'still') {
      v.preload = 'metadata';
      v.src = mediaSrc.includes('#') ? mediaSrc : `${mediaSrc}#t=0.001`;
    } else {
      v.src = mediaSrc;
      v.play().catch(() => { /* autoplay refused (e.g. low-power mode): the poster stays */ });
    }
    return () => {
      v.pause();
      v.removeAttribute('src');
      v.preload = 'none';
      v.load();
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
            {bgImageSrc ? (
              // Decorative: it sits behind the title and fades out.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={bgImageSrc}
                alt=''
                aria-hidden='true'
                className='w-screen h-screen object-cover'
                style={{ objectPosition: 'center' }}
              />
            ) : (
              <div aria-hidden='true' className='w-screen h-screen' style={{ background: 'var(--servd-purple)' }} />
            )}
            {/* The dimming film is for photo backgrounds only — over the plain
                token purple it turned #5a2156 into a muddier #511e4d. */}
            {bgImageSrc && <div className='absolute inset-0 bg-black/10' />}
          </div>

          <div className='container mx-auto flex flex-col items-center justify-start relative z-10'>
            <div className='flex flex-col items-center justify-center w-full h-[100dvh] relative'>
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
                    <div className='relative w-full h-full pointer-events-none'>
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
                        />
                      ) : youTubeStill ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={youTubeStill}
                          alt={mediaAlt}
                          {...(!mediaAlt && { 'aria-hidden': true })}
                          className='w-full h-full object-cover rounded-xl'
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
                    <div className='relative w-full h-full pointer-events-none'>
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
            </div>

            <section
              className='flex flex-col w-full px-8 py-10 md:px-16 lg:py-20'
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
