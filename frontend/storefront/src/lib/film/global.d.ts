// The Lenis instance SmoothScroll creates, exposed so the cut, SkipScene and
// scene CTAs can stop, start and drive the one smooth scroller. Absent under
// reduced motion (Lenis never starts) and on the server.
export {}

declare global {
  interface Window {
    __lenis?: import('lenis').default
  }
}
