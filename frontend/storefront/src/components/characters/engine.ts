/**
 * FoodCrowd engine — plain three.js, loaded on demand from FoodCrowd.tsx.
 * One WebGLRenderer per crowd; transparent canvas so the page stage shows
 * through, with soft contact shadows on an invisible ground.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { CharacterKind } from './types'
import { buildCharacter, type BuildContext } from './characters'
import { Kit, radialTexture, sharedFace, sharedLimbs } from './kit'
import { Character } from './rig'

export interface EngineOptions {
  cast: CharacterKind[]
  excitement: number
  onFirstFrame?: () => void
}

export interface CrowdEngine {
  setCast(cast: CharacterKind[]): void
  setExcitement(v: number): void
  cheer(kind?: CharacterKind): void
  /** Glance at a viewport point (CSS px, clientX/clientY space). */
  look(clientX: number, clientY: number): void
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
  canvas.style.touchAction = 'pan-y'
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
  const idle = (fn: () => void) =>
    typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(fn, { timeout: 150 })
      : window.setTimeout(fn, 16)
  function queueWarm(kinds: CharacterKind[]): void {
    for (const k of kinds) if (!warmQueue.includes(k)) warmQueue.push(k)
    if (!warmPending) {
      warmPending = true
      idle(warmStep)
    }
  }
  function warmStep(): void {
    warmPending = false
    if (disposed) return
    const kind = warmQueue.shift()
    if (kind && !built.has(kind)) {
      // Build, then compile its materials against the real scene (so the
      // lights/shadow shader variants match) while it's still off-stage.
      const c = getChar(kind)
      scene.add(c.root)
      renderer.compile(scene, camera)
      scene.remove(c.root)
    }
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
    // Characters are built + shader-compiled one per idle slice (warmStep),
    // never all at once — a synchronous build of a whole crowd was a 100-200ms
    // main-thread block, felt as a stutter when a crowd mounted mid-scroll.
    // The stage stays empty until the whole cast is warm, then everyone is
    // placed at once and grows in, staggered.
    const missing = kinds.filter((k) => !built.has(k))
    if (missing.length) {
      queueWarm(missing)
      for (const c of shown) scene.remove(c.root)
      shown = []
      return
    }
    const next = kinds.map(getChar)
    const entering = next.filter((c) => !shown.includes(c))
    for (const c of shown) if (!next.includes(c)) scene.remove(c.root)
    for (const c of entering) scene.add(c.root)
    shown = next
    if (!reduced) entering.forEach((c, i) => c.enter(0.1 + i * 0.09))
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
      c.root.position.set(cx, 0, z)
      c.root.rotation.y = -cx * 0.035
      halfW = Math.max(halfW, Math.abs(cx) + w / 2)
      // distance at which this character's outer edge just fits (perspective-aware)
      dH = Math.max(dH, (Math.abs(cx) + w / 2 + 0.06) / tanH + z + 0.45)
    })
    const d = Math.max(dV, dH)
    const midY = (top + bottom) / 2
    lookAt.set(0, midY - 0.04, 0)
    camera.position.set(0, midY + d * 0.1, d)
    camera.lookAt(lookAt)
    camera.updateProjectionMatrix()

    const sc = key.shadow.camera
    sc.left = -halfW - 1.5
    sc.right = halfW + 1.5
    sc.top = 4
    sc.bottom = -3
    sc.near = 0.5
    sc.far = 25
    sc.updateProjectionMatrix()
    scene.updateMatrixWorld()
    requestRender()
  }

  /* ---------------- input ---------------- */
  const ndc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const lookPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.2)
  const target = new THREE.Vector3(0, 0.8, 6)
  const rawTarget = new THREE.Vector3()
  const pointer = { x: 0, y: 0, has: false, touch: false, last: -1e9, inside: false }
  let wander = { x: 0, y: 0.1, next: 0 }
  const coarse = window.matchMedia?.('(hover: none)').matches ?? false

  const now = () => performance.now() / 1000

  const setPointer = (x: number, y: number, touch: boolean) => {
    pointer.x = x
    pointer.y = y
    pointer.has = true
    pointer.touch = touch
    pointer.last = now()
    pointer.inside = true
    requestRender()
  }
  const onPointerMove = (e: PointerEvent) => setPointer(e.clientX, e.clientY, e.pointerType === 'touch')
  const onTouch = (e: TouchEvent) => {
    const t = e.touches[0]
    if (t) setPointer(t.clientX, t.clientY, true)
  }
  const onLeave = (e: MouseEvent) => {
    if (!e.relatedTarget) pointer.inside = false
  }
  const onPointerDown = (e: PointerEvent) => {
    setPointer(e.clientX, e.clientY, e.pointerType === 'touch')
    if (reduced) return
    const c = pick(e.clientX, e.clientY)
    if (c) c.jump({ height: 0.62, duration: 0.78, spin: true, armsUp: true })
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('touchstart', onTouch, { passive: true })
  window.addEventListener('touchmove', onTouch, { passive: true })
  document.addEventListener('mouseout', onLeave)
  canvas.addEventListener('pointerdown', onPointerDown)

  function toNdc(clientX: number, clientY: number, rect: DOMRect): THREE.Vector2 {
    return ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
  }

  function pick(clientX: number, clientY: number): Character | null {
    const rect = canvas.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
    raycaster.setFromCamera(toNdc(clientX, clientY, rect), camera)
    const hits = raycaster.intersectObjects(
      shown.map((c) => c.hit),
      false,
    )
    const first = hits[0]
    return first ? ((first.object.userData.character as Character | undefined) ?? null) : null
  }

  let hovered: Character | null = null
  function updateTarget(dt: number, t: number): void {
    const rect = canvas.getBoundingClientRect()
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
      toNdc(pointer.x, pointer.y, rect)
    }
    raycaster.setFromCamera(ndc, camera)
    if (raycaster.ray.intersectPlane(lookPlane, rawTarget)) {
      const k = reduced ? 1 : 1 - Math.exp(-(useWander ? 5 : 30) * dt)
      target.lerp(rawTarget, k)
    }

    // hover
    let h: Character | null = null
    if (!reduced && pointer.has && !pointer.touch && idleFor < 30) h = pick(pointer.x, pointer.y)
    if (h !== hovered) {
      if (hovered) hovered.hovered = false
      if (h) {
        h.hovered = true
        if (!h.airborne) h.jump({ height: 0.2, duration: 0.46 })
      }
      hovered = h
      canvas.style.cursor = h ? 'pointer' : ''
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

  const frame = (dt: number) => {
    t += dt
    excitement = damp(excitement, excitementTarget, 5, dt)
    updateTarget(dt, t)
    const fc = { t, dt, target, excitement: reduced ? 0 : excitement, reduced }
    for (const c of shown) c.update(fc)
    renderer.render(scene, camera)
    if (!firstFrame) {
      firstFrame = true
      try {
        opts.onFirstFrame?.()
      } catch {
        /* caller's problem, not ours */
      }
    }
  }

  const tick = () => {
    raf = 0
    if (disposed) return
    const nowMs = performance.now()
    const dt = Math.min(1 / 20, Math.max(0, (nowMs - last) / 1000))
    last = nowMs
    frame(reduced ? 1 / 60 : dt)
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
    requestRender()
  }
  reducedMq?.addEventListener?.('change', onMotion)

  /* ---------------- api ---------------- */
  const api: CrowdEngine = {
    setCast(next) {
      cast = next.filter((k, i) => next.indexOf(k) === i)
      layout()
    },
    setExcitement(v) {
      excitementTarget = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
    },
    cheer(kind) {
      if (reduced) return
      const who = kind ? shown.filter((c) => c.kind === kind) : shown
      who.forEach((c, i) => c.jump({ height: 0.48, duration: 0.7, armsUp: true, delay: kind ? 0 : i * 0.06 }))
    },
    look(x, y) {
      pointer.x = x
      pointer.y = y
      pointer.has = true
      pointer.inside = true
      pointer.last = now()
      requestRender()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('touchstart', onTouch)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('mouseout', onLeave)
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
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }

  api.setCast(opts.cast)
  requestRender()
  return api
}
