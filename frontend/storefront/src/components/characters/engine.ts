/**
 * FoodCrowd engine: plain three.js, loaded on demand from FoodCrowd.tsx.
 * One WebGLRenderer per crowd; transparent canvas so the page's sky shows
 * through, with soft contact shadows on an invisible ground.
 *
 * Paint-fast rules: the stage is framed from known footprints before any
 * model exists; the first two characters build in the first animation frame
 * and the rest follow one per frame, each popping into its own slot.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { CharacterKind, Mood } from './types'
import { FOOTPRINT, buildCharacter, type BuildContext } from './characters'
import { Kit, radialTexture, sharedFace, sharedLimbs, wispTexture, withDetail, zTexture } from './kit'
import { Character, type FrameContext } from './rig'

/** Mirrors `DayPart` in lib/world/clock.ts (kept local so the engine chunk has no app imports). */
export type CrowdDayPart = 'morning' | 'lunch' | 'afternoon' | 'dinner' | 'late' | 'night'

export interface CrowdWorld {
  dayPart: CrowdDayPart
  /** 0..1: bob rate and amplitude scale by 0.6 + 0.8·energy. */
  energy: number
  /** 0..1: above 0.5 the crowd dozes. */
  sleepy: number
}

export interface EngineOptions {
  cast: CharacterKind[]
  excitement: number
  /** Initial world; lighting snaps to it (no fade) before the first frame. */
  world?: CrowdWorld
  /** Manual sleepiness override 0..1 (effective = max(world, this)). */
  sleepy?: number
  onFirstFrame?: () => void
}

export interface CrowdEngine {
  setCast(cast: CharacterKind[]): void
  setExcitement(v: number): void
  /** Day-part lighting (1.2 s fade), energy and sleepiness. */
  setWorld(w: CrowdWorld): void
  /** Manual sleepiness override 0..1. */
  setSleepy(v: number): void
  cheer(kind?: CharacterKind): void
  /** Glance at a viewport point (CSS px, clientX/clientY space). */
  look(clientX: number, clientY: number): void
  /** Pull a face: one kind, or everyone. */
  react(mood: Mood, kind?: CharacterKind, seconds?: number): void
  /** An item landed at a viewport point: the matching (or nearest) character hops proudly toward it. */
  catchAt(clientX: number, clientY: number, kind?: CharacterKind): void
  /** Play a signature quirk: one kind, or a random character. */
  quirk(kind?: CharacterKind): void
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
const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const rand = (a: number, b: number) => a + Math.random() * (b - a)

/* ------------------------------------------------------------------ */
/* Day-part lighting                                                   */
/* ------------------------------------------------------------------ */

interface LightSpec {
  hemi: [sky: string, ground: string, intensity: number]
  key: [color: string, intensity: number, x: number, y: number, z: number]
  fill: [color: string, intensity: number]
  rim: [color: string, intensity: number, x: number, y: number, z: number]
  bounce: [color: string, intensity: number]
  /** Warm PointLight in front of the crowd so faces read at night. */
  lantern: number
  /** Contact-shadow opacity. */
  shadow: number
  /** Scales every material's reflections (the studio env is too bright at night). */
  env: number
}

const LIGHTS: Record<CrowdDayPart, LightSpec> = {
  // low warm key from the left, peachy sky
  morning: {
    hemi: ['#FFE3CC', '#F2A07A', 0.66],
    key: ['#FFCF9E', 2.4, -7, 3, 3.5],
    fill: ['#D8E4FF', 0.6],
    rim: ['#FFE7CF', 1.9, 2, 4, -6],
    bounce: ['#FFB98A', 0.45],
    lantern: 0,
    shadow: 0.18,
    env: 0.95,
  },
  // the original studio look
  lunch: {
    hemi: ['#FFF4E0', '#E8A53A', 0.6],
    key: ['#FFE6C2', 2.8, -5, 6.5, 4.5],
    fill: ['#CFE0FF', 0.8],
    rim: ['#FFFFFF', 2.4, 2, 4, -6],
    bounce: ['#FFCF4A', 0.55],
    lantern: 0,
    shadow: 0.2,
    env: 1,
  },
  // slightly amber
  afternoon: {
    hemi: ['#FFEBC8', '#E39A2E', 0.6],
    key: ['#FFD9A0', 2.7, -4.8, 5.6, 4.5],
    fill: ['#D6DDF5', 0.7],
    rim: ['#FFF1D6', 2.3, 2.5, 4, -6],
    bounce: ['#FFC23A', 0.6],
    lantern: 0,
    shadow: 0.2,
    env: 1,
  },
  // golden low rim from the right plus a warmer bounce
  dinner: {
    hemi: ['#FFE0B8', '#D9772A', 0.55],
    key: ['#FFC98A', 2.3, -4.5, 4.2, 5],
    fill: ['#FFE2C4', 0.5],
    rim: ['#FFB347', 3.3, 6, 1.8, -3.5],
    bounce: ['#FF9A3C', 0.85],
    lantern: 0,
    shadow: 0.22,
    env: 0.9,
  },
  // cool sky, key at ~35%, a lantern for the faces, no floor bounce
  late: {
    hemi: ['#8A86C9', '#3A2140', 0.62],
    key: ['#FFD7B0', 1.0, -4.5, 5, 4.5],
    fill: ['#9FB0FF', 0.35],
    rim: ['#C9B8FF', 1.7, 3, 4, -6],
    bounce: ['#FFCF4A', 0],
    lantern: 6,
    shadow: 0.15,
    env: 0.55,
  },
  night: {
    hemi: ['#5E73C9', '#1E1430', 0.66],
    key: ['#C8D6FF', 0.95, -5, 6.5, 4.5],
    fill: ['#8FA6FF', 0.3],
    rim: ['#A8C4FF', 1.8, 2, 4, -6],
    bounce: ['#FFCF4A', 0],
    lantern: 7.5,
    shadow: 0.14,
    env: 0.45,
  },
}

interface LightState {
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiI: number
  keyC: THREE.Color
  keyI: number
  keyP: THREE.Vector3
  fillC: THREE.Color
  fillI: number
  rimC: THREE.Color
  rimI: number
  rimP: THREE.Vector3
  bounceC: THREE.Color
  bounceI: number
  lantern: number
  shadow: number
  env: number
}

function lightState(s: LightSpec): LightState {
  return {
    hemiSky: new THREE.Color(s.hemi[0]),
    hemiGround: new THREE.Color(s.hemi[1]),
    hemiI: s.hemi[2],
    keyC: new THREE.Color(s.key[0]),
    keyI: s.key[1],
    keyP: new THREE.Vector3(s.key[2], s.key[3], s.key[4]),
    fillC: new THREE.Color(s.fill[0]),
    fillI: s.fill[1],
    rimC: new THREE.Color(s.rim[0]),
    rimI: s.rim[1],
    rimP: new THREE.Vector3(s.rim[2], s.rim[3], s.rim[4]),
    bounceC: new THREE.Color(s.bounce[0]),
    bounceI: s.bounce[1],
    lantern: s.lantern,
    shadow: s.shadow,
    env: s.env,
  }
}

function lerpLight(out: LightState, a: LightState, b: LightState, k: number): void {
  const n = (x: number, y: number) => x + (y - x) * k
  out.hemiSky.lerpColors(a.hemiSky, b.hemiSky, k)
  out.hemiGround.lerpColors(a.hemiGround, b.hemiGround, k)
  out.hemiI = n(a.hemiI, b.hemiI)
  out.keyC.lerpColors(a.keyC, b.keyC, k)
  out.keyI = n(a.keyI, b.keyI)
  out.keyP.lerpVectors(a.keyP, b.keyP, k)
  out.fillC.lerpColors(a.fillC, b.fillC, k)
  out.fillI = n(a.fillI, b.fillI)
  out.rimC.lerpColors(a.rimC, b.rimC, k)
  out.rimI = n(a.rimI, b.rimI)
  out.rimP.lerpVectors(a.rimP, b.rimP, k)
  out.bounceC.lerpColors(a.bounceC, b.bounceC, k)
  out.bounceI = n(a.bounceI, b.bounceI)
  out.lantern = n(a.lantern, b.lantern)
  out.shadow = n(a.shadow, b.shadow)
  out.env = n(a.env, b.env)
}

const DAYPARTS: readonly CrowdDayPart[] = ['morning', 'lunch', 'afternoon', 'dinner', 'late', 'night']
const isDayPart = (v: unknown): v is CrowdDayPart => typeof v === 'string' && (DAYPARTS as readonly string[]).includes(v)

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export function createCrowdEngine(host: HTMLElement, opts: EngineOptions): CrowdEngine | null {
  if (typeof window === 'undefined' || !webglAvailable()) return null

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  } catch {
    return null
  }
  renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1))
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

  // Phones get lighter lathes / sweeps / eyeballs.
  const detail = (window.innerWidth || 1024) < 600 ? 0.55 : 1

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
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  const fill = new THREE.DirectionalLight('#CFE0FF', 0.8)
  fill.position.set(5, 2.5, 4)
  const rim = new THREE.DirectionalLight('#FFFFFF', 2.4)
  rim.position.set(2, 4, -6)
  const bounce = new THREE.DirectionalLight('#FFCF4A', 0.55) // floor bounce
  bounce.position.set(0, -3, 3)
  // Always in the scene (intensity 0 by day) so night never recompiles shaders.
  const lantern = new THREE.PointLight('#FFB25E', 0, 0, 2)
  lantern.position.set(0, 1.8, 2.3)
  scene.add(hemi, key, key.target, fill, rim, bounce, lantern)

  /* ---------------- invisible ground ---------------- */
  const groundMat = kit.material(new THREE.ShadowMaterial({ color: '#6E3F00', opacity: 0.2 }))
  const ground = new THREE.Mesh(kit.geo(new THREE.PlaneGeometry(60, 60)), groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const blobTex = radialTexture(kit, 0.25)
  const blobMat = blobTex
    ? kit.material(new THREE.MeshBasicMaterial({ map: blobTex, color: '#5C3300', transparent: true, opacity: 0.38, depthWrite: false }))
    : null
  const blobGeo = blobMat ? kit.geo(new THREE.PlaneGeometry(1, 1)) : null

  /* ---------------- world state + lighting ---------------- */
  const initialWorld = opts.world && isDayPart(opts.world.dayPart) ? opts.world : null
  let dayPart: CrowdDayPart = initialWorld?.dayPart ?? 'lunch'
  let energyTarget = clamp01(initialWorld?.energy ?? 0.5)
  let energy = energyTarget
  let worldSleepy = clamp01(initialWorld?.sleepy ?? 0)
  let propSleepy = clamp01(opts.sleepy ?? 0)

  const light = lightState(LIGHTS[dayPart])
  const lightFrom = lightState(LIGHTS[dayPart])
  let lightTo = lightState(LIGHTS[dayPart])
  const lightTargets = new Map<CrowdDayPart, LightState>()
  const targetFor = (p: CrowdDayPart) => {
    let s = lightTargets.get(p)
    if (!s) {
      s = lightState(LIGHTS[p])
      lightTargets.set(p, s)
    }
    return s
  }
  let lightT = -1
  let appliedEnv = -1

  function applyLight(): void {
    hemi.color.copy(light.hemiSky)
    hemi.groundColor.copy(light.hemiGround)
    hemi.intensity = light.hemiI
    key.color.copy(light.keyC)
    key.intensity = light.keyI
    key.position.copy(light.keyP)
    fill.color.copy(light.fillC)
    fill.intensity = light.fillI
    rim.color.copy(light.rimC)
    rim.intensity = light.rimI
    rim.position.copy(light.rimP)
    bounce.color.copy(light.bounceC)
    bounce.intensity = light.bounceI
    lantern.intensity = light.lantern
    groundMat.opacity = light.shadow
    if (blobMat) blobMat.opacity = light.shadow * 1.9
    if (Math.abs(light.env - appliedEnv) > 0.004) {
      appliedEnv = light.env
      kit.forEachMaterial((m) => {
        const pm = m as THREE.MeshStandardMaterial
        if (typeof pm.envMapIntensity !== 'number') return
        const ud = pm.userData as { baseEnv?: number }
        if (ud.baseEnv === undefined) ud.baseEnv = pm.envMapIntensity
        pm.envMapIntensity = ud.baseEnv * light.env
      })
    }
  }
  applyLight()

  /* ---------------- characters ---------------- */
  const ctx: BuildContext = withDetail(detail, () => ({ kit, face: sharedFace(kit), limbs: sharedLimbs(kit), detail }))
  const hitGeo = kit.geo(new THREE.BoxGeometry(1, 1, 1))
  const hitMat = kit.material(new THREE.MeshBasicMaterial({ visible: false }))
  const zTex = zTexture(kit)
  const wispTex = wispTexture(kit)
  const rigShared = {
    hitGeo,
    hitMat,
    shadowGeo: blobGeo,
    shadowMat: blobMat,
    zTex,
    wispTex,
    track: <M extends THREE.Material>(m: M): M => kit.material(m),
  }
  const built = new Map<CharacterKind, Character>()
  let cast: CharacterKind[] = []
  let shown: Character[] = []
  /** Hit boxes of the shown cast, kept in sync by place() so picking never allocates. */
  const hitList: THREE.Object3D[] = []
  const hitResults: THREE.Intersection[] = []
  let slots: { kind: CharacterKind; x: number; z: number; rotY: number }[] = []
  let buildQueue: CharacterKind[] = []

  const getChar = (kind: CharacterKind): Character => {
    let c = built.get(kind)
    if (!c) {
      c = new Character(kind, buildCharacter(kind, ctx), rigShared)
      built.set(kind, c)
      // new materials pick up the current day-part reflections
      appliedEnv = -1
      applyLight()
    }
    return c
  }

  /** Build the next character(s) in the queue: two on the very first frame, then one per frame. */
  function pumpBuilds(): void {
    const n = built.size === 0 ? 2 : 1
    for (let i = 0; i < n && buildQueue.length; i++) {
      const kind = buildQueue.shift()
      if (kind && !built.has(kind)) getChar(kind)
    }
    place()
  }

  /* ---------------- layout ---------------- */
  let width = 0
  let height = 0
  const lookAt = new THREE.Vector3()

  /** Frames the stage from footprints (no models needed), then fills the slots that are built. */
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
    if (!kinds.length) {
      slots = []
      buildQueue = []
      place()
      return
    }

    const vfov = THREE.MathUtils.degToRad(camera.fov)
    const tanV = Math.tan(vfov / 2)
    const tanH = tanV * aspect
    const maxH = Math.max(...kinds.map((k) => FOOTPRINT[k].height))
    const top = maxH + 0.22 // headroom for hops
    const bottom = -0.08
    const halfV = (top - bottom) / 2
    const dV = halfV / tanV + 0.45

    // widen the gaps on wide stages so the crowd fills it, never crop on narrow ones
    const widths = kinds.map((k) => FOOTPRINT[k].width)
    const sum = widths.reduce((a, b) => a + b, 0)
    const minGap = aspect < 0.95 ? -0.06 : 0.04
    const avail = (tanH * (dV - 0.45) - 0.1) * 2
    const gap = Math.max(minGap, Math.min(0.5, (avail - sum) / Math.max(1, kinds.length - 1)))
    let x = -(sum + gap * (kinds.length - 1)) / 2
    let halfW = 0
    let dH = 0
    slots = kinds.map((kind, i) => {
      const w = widths[i]!
      const cx = x + w / 2
      x += w + gap
      const z = -0.07 * cx * cx
      halfW = Math.max(halfW, Math.abs(cx) + w / 2)
      // distance at which this character's outer edge just fits (perspective-aware)
      dH = Math.max(dH, (Math.abs(cx) + w / 2 + 0.06) / tanH + z + 0.45)
      return { kind, x: cx, z, rotY: -cx * 0.035 }
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
    lantern.position.set(halfW * 0.15, top + 0.35, 2.4)

    // queue the missing ones centre-out, so the middle of the stage fills first
    const mid = (kinds.length - 1) / 2
    buildQueue = kinds
      .map((k, i) => ({ k, d: Math.abs(i - mid) }))
      .filter(({ k }) => !built.has(k))
      .sort((a, b) => a.d - b.d)
      .map(({ k }) => k)
    place()
  }

  function place(): void {
    const next: Character[] = []
    for (const s of slots) {
      const c = built.get(s.kind)
      if (!c) continue
      if (!shown.includes(c)) {
        scene.add(c.root)
        if (!reduced) c.enter(0.02)
      }
      c.root.position.set(s.x, 0, s.z)
      c.root.rotation.y = s.rotY
      next.push(c)
    }
    for (const c of shown) if (!next.includes(c)) scene.remove(c.root)
    shown = next
    hitList.length = 0
    for (const c of shown) hitList.push(c.hit)
    shown.forEach((c, i) => {
      const nb: Character[] = []
      const l = shown[i - 1]
      const r = shown[i + 1]
      if (l) nb.push(l)
      if (r) nb.push(r)
      c.neighbours = nb
    })
    scene.updateMatrixWorld()
    requestRender()
  }

  /* ---------------- input ---------------- */
  const ndc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const lookPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.2)
  const crowdPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const target = new THREE.Vector3(0, 0.8, 6)
  const rawTarget = new THREE.Vector3()
  const cursor = new THREE.Vector3()
  const scratch = new THREE.Vector3()
  const pointer = { x: 0, y: 0, has: false, touch: false, last: -1e9, inside: false }
  const wander = { x: 0, y: 0.1, next: 0 }
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
    const c = pick(e.clientX, e.clientY)
    if (!c) return
    c.poke(!reduced)
    // the poke ripples: ±1 flinch after 90 ms, ±2 after 180 ms
    const i = shown.indexOf(c)
    for (const d of [-2, -1, 1, 2]) {
      const nb = shown[i + d]
      if (nb) nb.flinch(c, Math.abs(d) === 1 ? 0.09 : 0.18, Math.abs(d) === 1 ? 1 : 0.5)
    }
    ping(120, 220, 800, 1100, 8200, 9800)
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
    hitResults.length = 0
    raycaster.intersectObjects(hitList, false, hitResults)
    const first = hitResults[0]
    const c = first ? ((first.object.userData.character as Character | undefined) ?? null) : null
    hitResults.length = 0
    return c
  }

  /** A viewport point projected onto the look plane (where the crowd's gaze lives). */
  function screenToLook(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    raycaster.setFromCamera(toNdc(clientX, clientY, rect), camera)
    return raycaster.ray.intersectPlane(lookPlane, out) !== null
  }

  let hovered: Character | null = null
  let cursorLive = false
  function updateTarget(dt: number, t: number): void {
    const rect = canvas.getBoundingClientRect()
    const idleFor = now() - pointer.last
    const useWander = !pointer.has || (!pointer.inside && !pointer.touch) || ((pointer.touch || coarse) && idleFor > 5)
    if (useWander) {
      if (t > wander.next) {
        const straight = Math.random() < 0.3
        wander.x = straight ? 0 : (Math.random() * 2 - 1) * 0.95
        wander.y = straight ? 0.05 : Math.random() * 0.9 - 0.3
        wander.next = t + 1.6 + Math.random() * 2.6
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
    // the real pointer on the crowd's own plane, for the one-eyed peek
    cursorLive = !useWander && idleFor < 3 && raycaster.ray.intersectPlane(crowdPlane, cursor) !== null

    // hover
    let h: Character | null = null
    if (!reduced && pointer.has && !pointer.touch && idleFor < 30) h = pick(pointer.x, pointer.y)
    if (h !== hovered) {
      if (hovered) hovered.hovered = false
      if (h) {
        h.hovered = true
        if (!h.airborne && !h.dozing) h.jump({ height: 0.2, duration: 0.46 })
      }
      hovered = h
      canvas.style.cursor = h ? 'pointer' : ''
    }
  }

  /* ---------------- loop ---------------- */
  const reducedMq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let reduced = reducedMq?.matches ?? false
  let excitementTarget = clamp01(opts.excitement)
  let excitement = excitementTarget
  let inView = true
  let pageVisible = document.visibilityState !== 'hidden'
  let raf = 0
  let disposed = false
  let firstFrame = false
  let last = performance.now()
  let t = 0
  const fc: FrameContext = { t: 0, dt: 0, target, cursor: null, excitement: 0, energy: 0.5, sleepy: 0, reduced: false }

  const frame = (dt: number) => {
    t += dt
    excitement = damp(excitement, excitementTarget, 5, dt)
    energy = reduced ? energyTarget : damp(energy, energyTarget, 1.5, dt)
    if (lightT >= 0) {
      lightT += dt
      const k = reduced ? 1 : easeInOut(Math.min(1, lightT / 1.2))
      lerpLight(light, lightFrom, lightTo, k)
      applyLight()
      if (k >= 1) lightT = -1
    }
    updateTarget(dt, t)
    fc.t = t
    fc.dt = dt
    fc.cursor = cursorLive ? cursor : null
    fc.excitement = reduced ? 0 : excitement
    fc.energy = energy
    fc.sleepy = Math.max(worldSleepy, propSleepy)
    fc.reduced = reduced
    for (const c of shown) c.update(fc)
    renderer.render(scene, camera)
    if (!firstFrame && shown.length) {
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
    const elapsed = Math.max(0, (nowMs - last) / 1000)
    last = nowMs
    if (buildQueue.length && width > 1) pumpBuilds()
    // Reduced motion renders on demand; real elapsed time keeps its timers honest.
    frame(reduced ? Math.min(10, elapsed) : Math.min(1 / 20, elapsed))
    // (a requestRender() made during this tick may already have queued the next one)
    if (!raf && (shouldRun() || (buildQueue.length && inView && pageVisible && width > 1))) raf = requestAnimationFrame(tick)
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

  // Reduced motion has no loop, so timed faces (a 0.9 s surprise, an 8 s
  // wake-up) need a nudge when they are due to change.
  const pingTimers = new Set<number>()
  function ping(...ms: number[]): void {
    if (!reduced) {
      requestRender()
      return
    }
    requestRender()
    for (const d of ms) {
      const id = window.setTimeout(() => {
        pingTimers.delete(id)
        requestRender()
      }, d)
      pingTimers.add(id)
    }
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

  const byKind = (kind?: CharacterKind) => (kind ? shown.filter((c) => c.kind === kind) : shown)

  /* ---------------- api ---------------- */
  const api: CrowdEngine = {
    setCast(next) {
      cast = next.filter((k, i) => next.indexOf(k) === i)
      layout()
    },
    setExcitement(v) {
      excitementTarget = clamp01(v)
    },
    setWorld(w) {
      if (!w || !isDayPart(w.dayPart)) return
      energyTarget = clamp01(w.energy)
      worldSleepy = clamp01(w.sleepy)
      if (w.dayPart !== dayPart) {
        dayPart = w.dayPart
        lightTo = targetFor(dayPart)
        if (!firstFrame || reduced) {
          lerpLight(light, lightTo, lightTo, 1)
          applyLight()
          lightT = -1
        } else {
          lerpLight(lightFrom, light, light, 1)
          lightT = 0
        }
      }
      requestRender()
    },
    setSleepy(v) {
      propSleepy = clamp01(v)
      requestRender()
    },
    cheer(kind) {
      const who = byKind(kind)
      if (!who.length) return
      for (const c of who) c.wake(6)
      if (reduced) {
        for (const c of who) c.setMood('happy', 1.2)
        ping(1300, 6100)
        return
      }
      who.forEach((c, i) => c.jump({ height: 0.48, duration: 0.7, armsUp: true, delay: kind ? 0 : i * 0.06 }))
      // after a solo cheer, everyone else glances at whoever cheered
      const star = kind ? who[0] : undefined
      if (star) for (const c of shown) if (c !== star) c.glanceAt(star, rand(1, 1.4), 0.12 + Math.random() * 0.15)
    },
    look(x, y) {
      pointer.x = x
      pointer.y = y
      pointer.has = true
      pointer.inside = true
      pointer.last = now()
      requestRender()
    },
    react(mood, kind, seconds = 1.6) {
      const s = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) : 1.6
      for (const c of byKind(kind)) {
        c.setMood(mood, s)
        if (mood !== 'sleepy') c.wake(s + 1)
      }
      ping(s * 1000 + 60, s * 1000 + 1100)
    },
    catchAt(x, y, kind) {
      if (!shown.length) return
      let c: Character | undefined = kind ? shown.find((s) => s.kind === kind) : undefined
      if (!c) {
        // nearest on screen, by the head's projected x
        const rect = canvas.getBoundingClientRect()
        let best = Infinity
        for (const s of shown) {
          s.headWorld(scratch).project(camera)
          const sx = rect.left + ((scratch.x + 1) / 2) * rect.width
          const sy = rect.top + ((1 - scratch.y) / 2) * rect.height
          const d = Math.hypot(sx - x, (sy - y) * 0.35)
          if (d < best) {
            best = d
            c = s
          }
        }
      }
      if (!c) return
      c.wake(8)
      c.setMood('proud', 1.8)
      if (!reduced) c.jump({ height: 0.3, duration: 0.55, armsUp: true })
      if (screenToLook(x, y, scratch)) c.glanceAt(scratch, 1.6)
      const star = c
      for (const o of shown) if (o !== star) o.glanceAt(star, rand(0.9, 1.3), 0.15 + Math.random() * 0.2)
      ping(1900, 8100)
    },
    quirk(kind) {
      if (reduced || !shown.length) return
      const who = kind ? byKind(kind) : [shown[Math.floor(Math.random() * shown.length)]!]
      for (const c of who) c.quirk()
      requestRender()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      pingTimers.forEach((id) => window.clearTimeout(id))
      pingTimers.clear()
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
