/**
 * FoodCrowd engine — plain three.js, loaded on demand from FoodCrowd.tsx.
 * One WebGLRenderer per crowd; transparent canvas so the page stage shows
 * through, with soft contact shadows on an invisible ground.
 *
 * The crowd is a toy:
 *  - poke (pointerdown on a character) → hop; pokes within 1.2s build a combo
 *    (3: squash spin jump, 5: neighbours join, 8: the whole crowd parties);
 *  - mouse / pen: drag a character >6px to grab it, fling it, it flies
 *    ballistically, bounces twice and walks home;
 *  - touch: tap = poke, double-tap = launch. Never blocks vertical scroll;
 *  - fast scroll flicks make the crowd flinch (down) or hop (up).
 * Reduced motion: a frozen gaze (updated at most once a second, no easing),
 * no idle loops, and pokes answer with a still happy face for 600ms.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { onScrollFlick } from '@/lib/play'
import type { CharacterKind } from './types'
import { buildCharacter, type BuildContext } from './characters'
import { Kit, radialTexture, sharedFace, sharedLimbs } from './kit'
import { Character, type FrameContext } from './rig'

export interface EngineOptions {
  cast: CharacterKind[]
  excitement: number
  onFirstFrame?: () => void
  /** Poke / grab / throw enabled. Default true. */
  interactive?: boolean
  /** A character was poked (pointer or keyboard). Point in viewport px. */
  onPoke?: (kind: CharacterKind, combo: number, x: number, y: number) => void
  /** A character was thrown hard (>6 u/s) or launched. Point in viewport px. */
  onToss?: (x: number, y: number) => void
}

export interface CrowdEngine {
  setCast(cast: CharacterKind[]): void
  setExcitement(v: number): void
  /** One character (or all) hops; `big` = higher, spinning, neighbours join. */
  cheer(kind?: CharacterKind, big?: boolean): void
  /** Three staggered spin jumps from everyone, then settle. */
  party(): void
  /** Glance at a viewport point (CSS px, clientX/clientY space). */
  look(clientX: number, clientY: number): void
  setInteractive(v: boolean): void
  /**
   * Keyboard poke: a random character at home. A second press within 300ms
   * launches the same one. (x, y) = where the poke is reported (viewport px).
   */
  keyPoke(x: number, y: number): void
  dispose(): void
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt))

/** Pokes closer together than this build a combo (ms). */
const COMBO_MS = 1200
/** Double-tap / double-press window (ms). */
const DOUBLE_MS = 300
/** Pointer travel (px) that turns a press into a grab. */
const GRAB_PX = 6
/** Touch: a tap travels less than this (px) and lifts within TAP_MS. */
const TAP_PX = 12
const TAP_MS = 500
/** Release velocity window (ms) and clamp (world u/s). */
const RELEASE_MS = 80
const MAX_THROW = 14
const TOSS_SPEED = 6
/** Scroll-flick reactions at most this often (ms). */
const FLICK_MS = 700
/** Party: rounds, spacing (s), per-character stagger (s). */
const PARTY_ROUNDS = 3
const PARTY_GAP = 0.68
const PARTY_STAGGER = 0.06
/** Entrance: first delay, stagger (s). Per-character grow is 0.42s (rig). */
const ENTER_DELAY = 0.03
const ENTER_STAGGER = 0.06

const safe = (fn: () => void) => {
  try {
    fn()
  } catch {
    /* a caller's callback must never break the render loop */
  }
}

export function createCrowdEngine(host: HTMLElement, opts: EngineOptions): CrowdEngine | null {
  if (typeof window === 'undefined' || !webglAvailable()) return null

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  } catch {
    return null
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // Vertical page scroll always wins on touch; there is no touch drag.
  canvas.style.touchAction = 'pan-y'
  canvas.style.userSelect = 'none'
  canvas.style.setProperty('-webkit-user-select', 'none')
  canvas.style.setProperty('-webkit-tap-highlight-color', 'transparent')
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)

  const kit = new Kit()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)

  // Image-based reflections from a procedural studio (no network).
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment(renderer)
  const envRT = pmrem.fromScene(room, 0.04)
  room.dispose()
  scene.environment = envRT.texture

  /* ---------------- lights ---------------- */
  const hemi = new THREE.HemisphereLight('#FFF4E0', '#E8A53A', 0.6)
  const key = new THREE.DirectionalLight('#FFE6C2', 2.8)
  key.position.set(-5, 6.5, 4.5)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  const fill = new THREE.DirectionalLight('#CFE0FF', 0.8)
  fill.position.set(5, 2.5, 4)
  const rim = new THREE.DirectionalLight('#FFFFFF', 2.4)
  rim.position.set(2, 4, -6)
  const bounce = new THREE.DirectionalLight('#FFCF4A', 0.55) // butter-yellow floor bounce
  bounce.position.set(0, -3, 3)
  scene.add(hemi, key, key.target, fill, rim, bounce)

  /* ---------------- invisible ground ---------------- */
  const ground = new THREE.Mesh(
    kit.geo(new THREE.PlaneGeometry(60, 60)),
    kit.material(new THREE.ShadowMaterial({ color: '#6E3F00', opacity: 0.2 })),
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const blobTex = radialTexture(kit, 0.25)
  const blobMat = blobTex
    ? kit.material(new THREE.MeshBasicMaterial({ map: blobTex, color: '#5C3300', transparent: true, opacity: 0.38, depthWrite: false }))
    : null
  const blobGeo = blobMat ? kit.geo(new THREE.PlaneGeometry(1, 1)) : null

  /* ---------------- characters ---------------- */
  const ctx: BuildContext = { kit, face: sharedFace(kit), limbs: sharedLimbs(kit) }
  const hitGeo = kit.geo(new THREE.BoxGeometry(1, 1, 1))
  const hitMat = kit.material(new THREE.MeshBasicMaterial({ visible: false }))
  const built = new Map<CharacterKind, Character>()
  let cast: CharacterKind[] = []
  let shown: Character[] = []
  /** Hit boxes of `shown`, kept in step by layout (no per-pick allocation). */
  const hitList: THREE.Object3D[] = []

  const getChar = (kind: CharacterKind): Character => {
    let c = built.get(kind)
    if (!c) {
      c = new Character(kind, buildCharacter(kind, ctx), hitGeo, hitMat, blobGeo, blobMat)
      built.set(kind, c)
    }
    return c
  }

  /* ---------------- incremental warm-up ---------------- */
  const warmQueue: CharacterKind[] = []
  let warmPending = false
  const idle = (fn: (deadline?: IdleDeadline) => void) =>
    typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(fn, { timeout: 120 })
      : window.setTimeout(fn, 16)
  function queueWarm(kinds: CharacterKind[]): void {
    for (const k of kinds) if (!warmQueue.includes(k)) warmQueue.push(k)
    if (!warmPending) {
      warmPending = true
      idle(warmStep)
    }
  }
  function warmStep(deadline?: IdleDeadline): void {
    warmPending = false
    if (disposed) return
    // Build + compile one character per slice, or more while the idle slice
    // still has room — the stage waits for the whole cast, so finish fast.
    do {
      const kind = warmQueue.shift()
      if (!kind) break
      if (!built.has(kind)) {
        // Build, then compile its materials against the real scene (so the
        // lights/shadow shader variants match) while it's still off-stage.
        const c = getChar(kind)
        scene.add(c.root)
        renderer.compile(scene, camera)
        scene.remove(c.root)
      }
    } while (warmQueue.length && deadline && !deadline.didTimeout && deadline.timeRemaining() > 24)
    if (warmQueue.length) {
      warmPending = true
      idle(warmStep)
    } else {
      layout()
      requestRender()
    }
  }

  /* ---------------- layout ---------------- */
  let width = 0
  let height = 0
  const lookAt = new THREE.Vector3()

  function layout(): void {
    width = host.clientWidth
    height = host.clientHeight
    if (width < 2 || height < 2) return
    renderer.setSize(width, height, false)
    const aspect = width / height
    camera.aspect = aspect
    camera.fov = aspect < 0.95 ? 34 : 30

    const n = Math.min(cast.length, aspect < 0.95 ? 3 : aspect < 1.35 ? 4 : cast.length)
    const start = Math.max(0, Math.floor((cast.length - n) / 2))
    const kinds = cast.slice(start, start + n)
    // Characters are built + shader-compiled in idle slices (warmStep), never
    // all at once — a synchronous build of a whole crowd was a 100-200ms
    // main-thread block, felt as a stutter when a crowd mounted mid-scroll.
    // Whoever is already on stage stays there while the newcomers warm; the
    // new cast is then placed at once and grows in, quickly staggered.
    const missing = kinds.filter((k) => !built.has(k))
    if (missing.length) {
      queueWarm(missing)
      return
    }
    const next = kinds.map(getChar)
    const entering = next.filter((c) => !shown.includes(c))
    for (const c of shown) {
      if (next.includes(c)) continue
      if (c === grabbed) dropGrab()
      if (c === flyer) flyer = null
      c.settle()
      c.hovered = false
      if (c === hovered) hovered = null
      scene.remove(c.root)
    }
    for (const c of entering) scene.add(c.root)
    shown = next
    hitList.length = 0
    for (const c of shown) hitList.push(c.hit)
    if (!shown.length) return

    const vfov = THREE.MathUtils.degToRad(camera.fov)
    const tanV = Math.tan(vfov / 2)
    const tanH = tanV * aspect
    const maxH = Math.max(...shown.map((c) => c.built.height))
    const top = maxH + 0.22 // headroom for hops
    const bottom = -0.08
    const halfV = (top - bottom) / 2
    const dV = halfV / tanV + 0.45

    // widen the gaps on wide stages so the crowd fills it, never crop on narrow ones
    const widths = shown.map((c) => c.built.width)
    const sum = widths.reduce((a, b) => a + b, 0)
    const minGap = aspect < 0.95 ? -0.06 : 0.04
    const avail = (tanH * (dV - 0.45) - 0.1) * 2
    const gap = Math.max(minGap, Math.min(0.5, (avail - sum) / Math.max(1, shown.length - 1)))
    let x = -(sum + gap * (shown.length - 1)) / 2
    let halfW = 0
    let dH = 0
    shown.forEach((c, i) => {
      const w = widths[i]!
      const cx = x + w / 2
      x += w + gap
      const z = -0.07 * cx * cx
      c.setSlot(cx, z, -cx * 0.035)
      halfW = Math.max(halfW, Math.abs(cx) + w / 2)
      // distance at which this character's outer edge just fits (perspective-aware)
      dH = Math.max(dH, (Math.abs(cx) + w / 2 + 0.06) / tanH + z + 0.45)
    })
    const d = Math.max(dV, dH)
    // Thrown characters bounce off the visible edges of the stage.
    const halfVis = tanH * d
    for (const c of shown) c.boundX = Math.max(0.2, halfVis - c.built.width * 0.45)
    const midY = (top + bottom) / 2
    lookAt.set(0, midY - 0.04, 0)
    camera.position.set(0, midY + d * 0.1, d)
    camera.lookAt(lookAt)
    camera.updateProjectionMatrix()

    const sc = key.shadow.camera
    sc.left = -Math.max(halfW, halfVis) - 1.5
    sc.right = Math.max(halfW, halfVis) + 1.5
    sc.top = 4
    sc.bottom = -3
    sc.near = 0.5
    sc.far = 25
    sc.updateProjectionMatrix()
    scene.updateMatrixWorld()

    // Enter only after the camera is placed, on the wall clock: the whole
    // cast is visible within ENTER_DELAY + (n-1)·STAGGER (≤ 0.35s) of the
    // first populated frame, whatever the frame rate.
    const wallMs = performance.now()
    if (!reduced) entering.forEach((c, i) => c.enter(ENTER_DELAY + i * ENTER_STAGGER, wallMs))
    requestRender()
  }

  /* ---------------- input ---------------- */
  const ndc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const lookPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.2)
  const grabPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const target = new THREE.Vector3(0, 0.8, 6)
  const rawTarget = new THREE.Vector3()
  const planeHit = new THREE.Vector3()
  const hitResults: THREE.Intersection[] = []
  const pointer = { x: 0, y: 0, has: false, touch: false, last: -1e9, inside: false }
  let wander = { x: 0, y: 0.1, next: 0 }
  const coarse = window.matchMedia?.('(hover: none)').matches ?? false
  let interactive = opts.interactive !== false

  const now = () => performance.now() / 1000

  // reduced motion: the gaze is a still that changes at most once a second
  let gazeAt = -1e9
  let gazeTimer = 0
  let restoreTimer = 0
  function scheduleGaze(): void {
    if (gazeTimer || disposed) return
    const wait = Math.max(0, 1000 - (performance.now() - gazeAt))
    gazeTimer = window.setTimeout(() => {
      gazeTimer = 0
      requestRender()
    }, wait)
  }
  /** Reduced motion: one more still frame once the happy face times out. */
  function scheduleRestore(): void {
    if (disposed) return
    if (restoreTimer) window.clearTimeout(restoreTimer)
    restoreTimer = window.setTimeout(() => {
      restoreTimer = 0
      requestRender()
    }, 620)
  }

  const setPointer = (x: number, y: number, touch: boolean) => {
    pointer.x = x
    pointer.y = y
    pointer.has = true
    pointer.touch = touch
    pointer.last = now()
    pointer.inside = true
    if (reduced) scheduleGaze()
    else requestRender()
  }

  // press → maybe-grab bookkeeping (mouse / pen only)
  let pendId = -1
  let pendX = 0
  let pendY = 0
  let pendC: Character | null = null
  let grabbed: Character | null = null
  /** Last thrown / launched character, watched by the others until it lands. */
  let flyer: Character | null = null
  let grabDX = 0
  let grabDY = 0

  // release-velocity samples (world units, ms) — fixed ring, no allocation
  const S = 16
  const sT = new Float64Array(S)
  const sX = new Float64Array(S)
  const sY = new Float64Array(S)
  let sN = 0
  let sHead = 0
  let relVX = 0
  let relVY = 0
  function pushSample(ms: number, x: number, y: number): void {
    sT[sHead] = ms
    sX[sHead] = x
    sY[sHead] = y
    sHead = (sHead + 1) % S
    sN = Math.min(S, sN + 1)
  }
  function releaseVelocity(nowMs: number): void {
    relVX = 0
    relVY = 0
    if (sN < 2) return
    const newest = (sHead - 1 + S) % S
    if (nowMs - (sT[newest] ?? 0) > RELEASE_MS) return // paused before letting go
    let oldest = newest
    for (let k = 1; k < sN; k++) {
      const j = (newest - k + S) % S
      if (nowMs - (sT[j] ?? 0) > RELEASE_MS) break
      oldest = j
    }
    if (oldest === newest) {
      const j = (newest - 1 + S) % S
      if (nowMs - (sT[j] ?? 0) > RELEASE_MS * 2) return
      oldest = j
    }
    const dtS = ((sT[newest] ?? 0) - (sT[oldest] ?? 0)) / 1000
    if (dtS < 0.004) return
    relVX = ((sX[newest] ?? 0) - (sX[oldest] ?? 0)) / dtS
    relVY = ((sY[newest] ?? 0) - (sY[oldest] ?? 0)) / dtS
    const sp = Math.hypot(relVX, relVY)
    if (sp > MAX_THROW) {
      relVX *= MAX_THROW / sp
      relVY *= MAX_THROW / sp
    }
  }

  /** Pointer → the plane z = `z` (world). Writes `planeHit`. */
  function projectToPlane(clientX: number, clientY: number, z: number): boolean {
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    raycaster.setFromCamera(toNdc(clientX, clientY, rect), camera)
    grabPlane.constant = -z
    return raycaster.ray.intersectPlane(grabPlane, planeHit) !== null
  }

  function setCursor(v: string): void {
    if (canvas.style.cursor !== v) canvas.style.cursor = v
  }

  function startGrab(): void {
    const c = pendC
    if (!c || reduced || !interactive || !shown.includes(c)) {
      pendC = null
      pendId = -1
      return
    }
    if (!projectToPlane(pendX, pendY, c.root.position.z)) return
    grabbed = c
    flyer = null
    grabDX = planeHit.x - c.root.position.x
    grabDY = c.grab(planeHit.y - c.root.position.y)
    sN = 0
    sHead = 0
    pushSample(performance.now(), c.root.position.x, c.root.position.y)
    try {
      canvas.setPointerCapture(pendId)
    } catch {
      /* pointer already gone */
    }
    if (hovered) hovered.hovered = false
    hovered = null
    setCursor('grabbing')
    wake()
  }

  function dragTo(clientX: number, clientY: number): void {
    const c = grabbed
    if (!c || !projectToPlane(clientX, clientY, c.root.position.z)) return
    const fx = planeHit.x - grabDX
    const fy = planeHit.y - grabDY
    c.hold(fx, fy)
    pushSample(performance.now(), fx, Math.max(0, fy))
    requestRender()
  }

  /** End a grab. `e` given = a real release (throw); otherwise just drop. */
  function dropGrab(e?: PointerEvent): void {
    const c = grabbed
    const id = pendId
    grabbed = null
    pendC = null
    pendId = -1
    if (!c) return
    if (e) releaseVelocity(performance.now())
    else {
      relVX = 0
      relVY = 0
    }
    try {
      if (id >= 0 && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
    } catch {
      /* ignore */
    }
    if (reduced) c.settle()
    else {
      c.release(relVX, relVY)
      flyer = c
      if (e && Math.hypot(relVX, relVY) > TOSS_SPEED) {
        const x = e.clientX
        const y = e.clientY
        safe(() => opts.onToss?.(x, y))
      }
    }
    hoverDirty = true
    setCursor('')
    requestRender()
  }

  /* ---------------- poke + combos ---------------- */
  let combo = 0
  let comboAt = -1e9
  let tapC: Character | null = null
  let tapAt = -1e9
  let keyC: Character | null = null
  let keyAt = -1e9

  function cheerNeighbours(c: Character, delay: number, height = 0.3): void {
    const i = shown.indexOf(c)
    if (i < 0) return
    shown[i - 1]?.jump({ height, duration: 0.55, armsUp: true, delay })
    shown[i + 1]?.jump({ height, duration: 0.55, armsUp: true, delay })
  }

  function poke(c: Character, x: number, y: number, launch: boolean): void {
    const nowMs = performance.now()
    combo = nowMs - comboAt <= COMBO_MS ? combo + 1 : 1
    comboAt = nowMs
    const n = combo
    if (n >= 8) {
      combo = 0
      comboAt = -1e9
    }
    if (reduced) {
      // a still, hand-authored answer: eyes closed, big smile, one frame
      c.staticHappy(nowMs + 600)
      scheduleRestore()
      requestRender()
    } else {
      if (launch) {
        c.launch()
        flyer = c
      } else if (n >= 3) {
        c.jump({ height: 0.72, duration: 0.8, spin: true, armsUp: true, squash: true })
      } else {
        c.jump({ height: 0.62, duration: 0.78, spin: true, armsUp: true })
      }
      if (n >= 5) cheerNeighbours(c, 0.08, 0.34)
      wake()
    }
    safe(() => opts.onPoke?.(c.kind, n, x, y))
    if (launch) safe(() => opts.onToss?.(x, y))
  }

  // touch: a poke is a clean tap (down + up, little travel, no pan). A swipe
  // that starts on a character is the page scrolling, not a poke — the
  // browser pans (touch-action: pan-y) and sends pointercancel.
  let tId = -1
  let tC: Character | null = null
  let tX = 0
  let tY = 0
  let tAt = 0
  const clearTouch = () => {
    tId = -1
    tC = null
  }

  const onPointerMove = (e: PointerEvent) => {
    const touch = e.pointerType === 'touch'
    setPointer(e.clientX, e.clientY, touch)
    if (tC && e.pointerId === tId && Math.hypot(e.clientX - tX, e.clientY - tY) > TAP_PX) clearTouch()
    if (pendC && e.pointerId === pendId) {
      if (!grabbed && e.buttons === 0) {
        // the button came up somewhere we never heard about
        pendC = null
        pendId = -1
      } else if (!grabbed) {
        if (Math.hypot(e.clientX - pendX, e.clientY - pendY) > GRAB_PX) startGrab()
      }
      if (grabbed) dragTo(e.clientX, e.clientY)
    } else if (!touch) {
      if (reduced) refreshHover()
      else hoverDirty = true
    }
  }
  const onTouch = (e: TouchEvent) => {
    const t = e.touches[0]
    if (t) setPointer(t.clientX, t.clientY, true)
  }
  const onLeave = (e: MouseEvent) => {
    if (!e.relatedTarget) {
      pointer.inside = false
      hoverDirty = true
    }
  }
  const onPointerDown = (e: PointerEvent) => {
    const touch = e.pointerType === 'touch'
    setPointer(e.clientX, e.clientY, touch)
    if (!interactive || e.button > 0 || grabbed) return
    const c = pick(e.clientX, e.clientY)
    if (!c) return
    if (touch) {
      tId = e.pointerId
      tC = c
      tX = e.clientX
      tY = e.clientY
      tAt = performance.now()
      return
    }
    // Mouse/pen double-click = launch only under reduced motion, where
    // dragging is off and this is the way to the airtime sticker.
    poke(c, e.clientX, e.clientY, reduced && isDoubleTap(c))
    if (!reduced) {
      pendC = c
      pendId = e.pointerId
      pendX = e.clientX
      pendY = e.clientY
    }
  }
  /** Same character tapped again within DOUBLE_MS → true (and consumes it). */
  function isDoubleTap(c: Character): boolean {
    const nowMs = performance.now()
    if (tapC === c && nowMs - tapAt < DOUBLE_MS) {
      tapC = null
      return true
    }
    tapC = c
    tapAt = nowMs
    return false
  }
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === tId) {
      const c = tC
      const quick = performance.now() - tAt < TAP_MS
      clearTouch()
      // tap = poke, double-tap on the same character = launch
      if (c && quick && interactive && shown.includes(c)) poke(c, e.clientX, e.clientY, isDoubleTap(c))
      return
    }
    if (e.pointerId !== pendId) return
    if (grabbed) dropGrab(e)
    else {
      pendC = null
      pendId = -1
    }
  }
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId === tId) clearTouch()
    if (e.pointerId !== pendId) return
    if (grabbed) dropGrab()
    else {
      pendC = null
      pendId = -1
    }
  }
  const onBlur = () => {
    clearTouch()
    if (grabbed) dropGrab()
    pendC = null
    pendId = -1
  }
  const onSelectStart = (e: Event) => {
    if (pendC || grabbed) e.preventDefault()
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerCancel, { passive: true })
  window.addEventListener('blur', onBlur)
  window.addEventListener('touchstart', onTouch, { passive: true })
  window.addEventListener('touchmove', onTouch, { passive: true })
  document.addEventListener('mouseout', onLeave)
  document.addEventListener('selectstart', onSelectStart)
  canvas.addEventListener('pointerdown', onPointerDown)

  function toNdc(clientX: number, clientY: number, rect: DOMRect): THREE.Vector2 {
    return ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
  }

  /** Pointer-event only (never per frame). */
  function pick(clientX: number, clientY: number): Character | null {
    if (!hitList.length) return null
    const rect = canvas.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
    raycaster.setFromCamera(toNdc(clientX, clientY, rect), camera)
    hitResults.length = 0
    raycaster.intersectObjects(hitList, false, hitResults)
    const first = hitResults[0]
    hitResults.length = 0
    return first ? ((first.object.userData.character as Character | undefined) ?? null) : null
  }

  let hovered: Character | null = null
  let hoverDirty = false
  /** Hover + cursor; runs once per frame after a pointer move, not every frame. */
  function refreshHover(): void {
    hoverDirty = false
    let h: Character | null = null
    if (!grabbed && pointer.has && !pointer.touch && pointer.inside) h = pick(pointer.x, pointer.y)
    if (h !== hovered) {
      if (hovered) hovered.hovered = false
      if (h && !reduced) {
        h.hovered = true
        if (!h.airborne) h.jump({ height: 0.2, duration: 0.46 })
      }
      hovered = h
    }
    if (grabbed) setCursor('grabbing')
    else if (h && interactive) setCursor(!reduced && !coarse ? 'grab' : 'pointer')
    else setCursor('')
  }

  function watched(): Character | null {
    if (grabbed) return grabbed
    if (flyer && flyer.flying) return flyer
    return null
  }

  function updateTarget(dt: number, t: number, wallMs: number): void {
    // the rest of the crowd watches whoever is being thrown around
    const w = watched()
    if (w && !reduced) {
      rawTarget.copy(w.root.position)
      rawTarget.y += w.built.height * 0.6
      rawTarget.z += 0.4
      target.lerp(rawTarget, 1 - Math.exp(-30 * dt))
      return
    }
    if (reduced) {
      // Frozen gaze: re-aimed at most once a second, snapped (no easing, no
      // wander). Interpolating at k=1 every frame read as jitter.
      if (wallMs - gazeAt < 1000) return
      gazeAt = wallMs
      if (pointer.has && pointer.inside) toNdc(pointer.x, pointer.y, canvas.getBoundingClientRect())
      else ndc.set(0, 0.05)
      raycaster.setFromCamera(ndc, camera)
      if (raycaster.ray.intersectPlane(lookPlane, rawTarget)) target.copy(rawTarget)
      return
    }
    const idleFor = now() - pointer.last
    const useWander = !pointer.has || (!pointer.inside && !pointer.touch) || ((pointer.touch || coarse) && idleFor > 5)
    if (useWander) {
      if (t > wander.next) {
        const straight = Math.random() < 0.3
        wander = {
          x: straight ? 0 : (Math.random() * 2 - 1) * 0.95,
          y: straight ? 0.05 : Math.random() * 0.9 - 0.3,
          next: t + 1.6 + Math.random() * 2.6,
        }
      }
      ndc.set(wander.x, wander.y)
    } else {
      toNdc(pointer.x, pointer.y, canvas.getBoundingClientRect())
    }
    raycaster.setFromCamera(ndc, camera)
    if (raycaster.ray.intersectPlane(lookPlane, rawTarget)) {
      target.lerp(rawTarget, 1 - Math.exp(-(useWander ? 5 : 30) * dt))
    }
  }

  /* ---------------- loop ---------------- */
  const reducedMq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let reduced = reducedMq?.matches ?? false
  let excitementTarget = Math.min(1, Math.max(0, opts.excitement))
  let excitement = excitementTarget
  let inView = true
  let pageVisible = document.visibilityState !== 'hidden'
  let raf = 0
  let disposed = false
  let firstFrame = false
  let last = performance.now()
  let t = 0

  // party schedule: per-slot count of rounds already started
  let partyStart = -1
  const partyRound = new Int8Array(16)

  function runParty(): void {
    if (partyStart < 0) return
    const pt = t - partyStart
    for (let i = 0; i < shown.length && i < partyRound.length; i++) {
      const r = partyRound[i] ?? PARTY_ROUNDS
      if (r >= PARTY_ROUNDS || pt < r * PARTY_GAP + i * PARTY_STAGGER) continue
      partyRound[i] = r + 1
      shown[i]!.jump({ height: 0.5, duration: 0.62, spin: true, armsUp: true, force: true })
    }
    if (pt > (PARTY_ROUNDS - 1) * PARTY_GAP + shown.length * PARTY_STAGGER + 0.7) partyStart = -1
  }

  const fc: FrameContext = { t: 0, dt: 0, wall: 0, target, excitement: 0, reduced: false }

  const frame = (dt: number, wallMs: number) => {
    t += dt
    excitement = damp(excitement, excitementTarget, 5, dt)
    if (reduced && (grabbed || pendC)) dropGrab()
    if (hoverDirty) refreshHover()
    runParty()
    updateTarget(dt, t, wallMs)
    if (flyer && !flyer.toyBusy) flyer = null
    const focus = watched()
    fc.t = t
    fc.dt = dt
    fc.wall = wallMs
    fc.reduced = reduced
    fc.excitement = reduced ? 0 : partyStart >= 0 ? 1 : excitement
    for (let i = 0; i < shown.length; i++) {
      const c = shown[i]!
      // the one in the air looks out at the viewer, everyone else at it
      fc.target = c === focus ? camera.position : target
      c.update(fc)
    }
    fc.target = target
    renderer.render(scene, camera)
    // "Ready" means the cast is on stage, not merely that a frame drew.
    if (!firstFrame && (shown.length > 0 || cast.length === 0)) {
      firstFrame = true
      safe(() => opts.onFirstFrame?.())
    }
  }

  const tick = () => {
    raf = 0
    if (disposed) return
    const nowMs = performance.now()
    const dt = Math.min(1 / 20, Math.max(0, (nowMs - last) / 1000))
    last = nowMs
    frame(reduced ? 1 / 60 : dt, nowMs)
    if (shouldRun()) raf = requestAnimationFrame(tick)
  }
  const shouldRun = () => !disposed && !reduced && inView && pageVisible && width > 1
  function wake(): void {
    if (!raf && shouldRun()) {
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
  }
  /** Reduced motion: render only when something changed. */
  function requestRender(): void {
    if (disposed || raf) return
    if (reduced) {
      if (inView && pageVisible && width > 1) raf = requestAnimationFrame(tick)
    } else wake()
  }

  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          inView = entries.some((e) => e.isIntersecting)
          if (inView) requestRender()
        })
      : null
  io?.observe(host)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null
  ro?.observe(host)
  const onResize = () => layout()
  if (!ro) window.addEventListener('resize', onResize)
  const onVis = () => {
    pageVisible = document.visibilityState !== 'hidden'
    if (pageVisible) requestRender()
  }
  document.addEventListener('visibilitychange', onVis)
  const onMotion = () => {
    reduced = reducedMq?.matches ?? false
    gazeAt = -1e9
    partyStart = -1
    requestRender()
  }
  reducedMq?.addEventListener?.('change', onMotion)

  /* ---------------- scroll flicks ---------------- */
  let flickAt = -1e9
  let offFlick: () => void = () => {}
  try {
    offFlick = onScrollFlick((v) => {
      if (disposed || reduced || !inView || !pageVisible || !shown.length) return
      const nowMs = performance.now()
      if (nowMs - flickAt < FLICK_MS) return
      flickAt = nowMs
      if (v > 0) {
        // flung down the page: everyone flinches back and blinks
        for (let i = 0; i < shown.length; i++) shown[i]!.flinch()
      } else {
        // flung back up: a staggered "whee" hop
        for (let i = 0; i < shown.length; i++) shown[i]!.jump({ height: 0.26, duration: 0.5, armsUp: true, delay: i * 0.05 })
      }
      wake()
    })
  } catch {
    offFlick = () => {}
  }

  /* ---------------- api ---------------- */
  const api: CrowdEngine = {
    setCast(next) {
      cast = next.filter((k, i) => next.indexOf(k) === i)
      layout()
    },
    setExcitement(v) {
      excitementTarget = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
    },
    cheer(kind, big) {
      if (reduced) return
      for (let i = 0; i < shown.length; i++) {
        const c = shown[i]!
        if (kind && c.kind !== kind) continue
        const delay = kind ? 0 : i * 0.06
        if (big) {
          c.jump({ height: 0.48 * 1.4, duration: 0.84, spin: true, armsUp: true, delay })
          if (kind) cheerNeighbours(c, 0.08)
        } else {
          c.jump({ height: 0.48, duration: 0.7, armsUp: true, delay })
        }
      }
      wake()
    },
    party() {
      if (!shown.length) return
      if (reduced) {
        const until = performance.now() + 600
        for (const c of shown) c.staticHappy(until)
        scheduleRestore()
        requestRender()
        return
      }
      if (!inView || !pageVisible) return // no surprise party on scroll-back
      partyStart = t
      partyRound.fill(0)
      for (const c of shown) c.wideHold = (PARTY_ROUNDS - 1) * PARTY_GAP + shown.length * PARTY_STAGGER + 0.7
      wake()
    },
    look(x, y) {
      pointer.x = x
      pointer.y = y
      pointer.has = true
      pointer.inside = true
      pointer.last = now()
      if (reduced) scheduleGaze()
      else requestRender()
    },
    setInteractive(v) {
      interactive = v
      if (!v) {
        if (grabbed) dropGrab()
        pendC = null
        pendId = -1
      }
      hoverDirty = true
      requestRender()
    },
    keyPoke(x, y) {
      if (!interactive || !shown.length) return
      const nowMs = performance.now()
      let c: Character | null = null
      let launch = false
      if (keyC && shown.includes(keyC) && nowMs - keyAt < DOUBLE_MS) {
        c = keyC
        launch = true
        keyC = null
      } else {
        // a random character, preferring one standing at home
        for (let tries = 0; tries < 6; tries++) {
          c = shown[Math.floor(Math.random() * shown.length)] ?? null
          if (c && !c.toyBusy) break
        }
        keyC = c
        keyAt = nowMs
      }
      if (c) poke(c, x, y, launch)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (gazeTimer) window.clearTimeout(gazeTimer)
      if (restoreTimer) window.clearTimeout(restoreTimer)
      gazeTimer = 0
      restoreTimer = 0
      try {
        if (pendId >= 0 && canvas.hasPointerCapture(pendId)) canvas.releasePointerCapture(pendId)
      } catch {
        /* ignore */
      }
      grabbed = null
      pendC = null
      flyer = null
      hovered = null
      safe(offFlick)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('touchstart', onTouch)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('mouseout', onLeave)
      document.removeEventListener('selectstart', onSelectStart)
      document.removeEventListener('visibilitychange', onVis)
      canvas.removeEventListener('pointerdown', onPointerDown)
      reducedMq?.removeEventListener?.('change', onMotion)
      io?.disconnect()
      ro?.disconnect()
      scene.environment = null
      envRT.dispose()
      pmrem.dispose()
      kit.dispose()
      built.clear()
      shown = []
      hitList.length = 0
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }

  api.setCast(opts.cast)
  requestRender()
  return api
}
