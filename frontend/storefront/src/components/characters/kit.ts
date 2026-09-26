/**
 * Shared toolkit for the procedural food characters: a resource tracker
 * (so every geometry/material/texture is disposed on unmount), smooth
 * geometry helpers, organic noise, and the face / limb builders.
 *
 * Only ever imported from the dynamically-loaded engine, so nothing here
 * runs during SSR.
 */
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

type PhysicalParams = THREE.MeshPhysicalMaterialParameters

export class Kit {
  private geos = new Set<THREE.BufferGeometry>()
  private mats = new Map<string, THREE.Material>()
  private extraMats = new Set<THREE.Material>()
  private texs = new Set<THREE.Texture>()

  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.add(g)
    return g
  }

  tex<T extends THREE.Texture>(t: T): T {
    this.texs.add(t)
    return t
  }

  /** Cached physical material; the key lets characters share identical finishes. */
  physical(key: string, params: PhysicalParams): THREE.MeshPhysicalMaterial {
    const hit = this.mats.get(key)
    if (hit) return hit as THREE.MeshPhysicalMaterial
    const m = new THREE.MeshPhysicalMaterial({ envMapIntensity: 0.45, ...params })
    this.mats.set(key, m)
    return m
  }

  material<T extends THREE.Material>(m: T): T {
    this.extraMats.add(m)
    return m
  }

  dispose(): void {
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.extraMats.forEach((m) => m.dispose())
    this.texs.forEach((t) => t.dispose())
    this.geos.clear()
    this.mats.clear()
    this.extraMats.clear()
    this.texs.clear()
  }
}

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(seed, 2654435761)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

const fade = (t: number) => t * t * (3 - 2 * t)

/** Smooth 3D value noise in [0,1]. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = fade(x - xi)
  const yf = fade(y - yi)
  const zf = fade(z - zi)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed)
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), xf), l(c(0, 1, 0), c(1, 1, 0), xf), yf),
    l(l(c(0, 0, 1), c(1, 0, 1), xf), l(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf,
  )
}

/** Fractal noise centred on 0, roughly in [-0.5, 0.5]. */
export function fbm(x: number, y: number, z: number, seed = 0): number {
  return noise3(x, y, z, seed) * 0.62 + noise3(x * 2.03, y * 2.03, z * 2.03, seed + 7) * 0.28 + noise3(x * 4.1, y * 4.1, z * 4.1, seed + 13) * 0.1 - 0.5
}

/**
 * Displaces a geometry along its normals with fractal noise. Vertices are
 * welded first so seams never crack. `mask` can fade the effect per vertex.
 */
export function organic(
  src: THREE.BufferGeometry,
  amp: number,
  freq: number,
  seed = 1,
  mask?: (p: THREE.Vector3) => number,
): THREE.BufferGeometry {
  const g0 = src.clone()
  g0.deleteAttribute('normal')
  g0.deleteAttribute('uv')
  const g = mergeVertices(g0)
  g0.dispose()
  src.dispose()
  g.computeVertexNormals()
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const nor = g.getAttribute('normal') as THREE.BufferAttribute
  const p = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    const m = mask ? mask(p) : 1
    if (m <= 0) continue
    const d = fbm(p.x * freq, p.y * freq, p.z * freq, seed) * amp * m
    pos.setXYZ(i, p.x + nor.getX(i) * d, p.y + nor.getY(i) * d, p.z + nor.getZ(i) * d)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
  return g
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Lathe through a Catmull-Rom smoothed profile of [radius, y] points. */
export function smoothLathe(
  pts: Array<[number, number]>,
  opts: { samples?: number; segments?: number; phiStart?: number; smooth?: boolean } = {},
): THREE.LatheGeometry {
  const { samples = 64, segments = 96, phiStart = Math.PI, smooth = true } = opts
  let profile: THREE.Vector2[]
  if (smooth) {
    const curve = new THREE.CatmullRomCurve3(
      pts.map(([r, y]) => new THREE.Vector3(r, y, 0)),
      false,
      'centripetal',
    )
    profile = curve.getPoints(samples).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y))
  } else {
    profile = pts.map(([r, y]) => new THREE.Vector2(r, y))
  }
  return new THREE.LatheGeometry(profile, segments, phiStart, Math.PI * 2)
}

/** Rounded polygon outline as a Shape (corners filleted with quadratic curves). */
export function roundedPolygon(points: Array<[number, number]>, radius: number): THREE.Shape {
  const shape = new THREE.Shape()
  const n = points.length
  const v = points.map(([x, y]) => new THREE.Vector2(x, y))
  for (let i = 0; i < n; i++) {
    const p = v[i]!
    const prev = v[(i - 1 + n) % n]!
    const next = v[(i + 1) % n]!
    const a = prev.clone().sub(p).normalize().multiplyScalar(radius).add(p)
    const b = next.clone().sub(p).normalize().multiplyScalar(radius).add(p)
    if (i === 0) shape.moveTo(a.x, a.y)
    else shape.lineTo(a.x, a.y)
    shape.quadraticCurveTo(p.x, p.y, b.x, b.y)
  }
  shape.closePath()
  return shape
}

/**
 * Generic swept tube: `center(t)` path, `frame(t)` returns [normal, binormal],
 * `radius(t, theta)` returns the cross-section radius. Ends pinch to points.
 */
export function sweep(
  center: (t: number) => THREE.Vector3,
  frame: (t: number) => [THREE.Vector3, THREE.Vector3],
  radius: (t: number, theta: number) => [number, number],
  tubular = 160,
  radial = 48,
  color?: (t: number, theta: number, out: THREE.Color) => void,
): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const c = new THREE.Color()
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular
    const C = center(t)
    const [N, B] = frame(t)
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2
      const [rn, rb] = radius(t, th)
      positions.push(C.x + N.x * Math.cos(th) * rn + B.x * Math.sin(th) * rb, C.y + N.y * Math.cos(th) * rn + B.y * Math.sin(th) * rb, C.z + N.z * Math.cos(th) * rn + B.z * Math.sin(th) * rb)
      if (color) {
        color(t, th, c)
        colors.push(c.r, c.g, c.b)
      }
    }
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j
      const b = (i + 1) * radial + j
      const a1 = i * radial + ((j + 1) % radial)
      const b1 = (i + 1) * radial + ((j + 1) % radial)
      indices.push(a, b, a1, b, b1, a1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

/* ------------------------------------------------------------------ */
/* Canvas textures                                                     */
/* ------------------------------------------------------------------ */

export function canvasTexture(kit: Kit, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  draw(ctx)
  const t = kit.tex(new THREE.CanvasTexture(canvas))
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** Soft radial blob (white centre → transparent edge) used for blush and contact shadows. */
export function radialTexture(kit: Kit, falloff = 0.5): THREE.CanvasTexture | null {
  return canvasTexture(kit, 128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(falloff, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
  })
}

/* ------------------------------------------------------------------ */
/* Faces                                                               */
/* ------------------------------------------------------------------ */

export interface EyeRig {
  /** Positioned on the face, never rotated/scaled: the look-at reference frame. */
  anchor: THREE.Group
  /** Blink / squint / widen scale lives here. */
  lid: THREE.Group
  /** Rotated to look at the target. */
  ball: THREE.Group
  baseScaleY: number
}

export interface FaceSpec {
  /** Front surface of the character: z at (x, y) in model space. */
  surfaceZ: (x: number, y: number) => number
  eyes: { x: number; y: number; r: number; stretch?: number }[]
  /** How far the eyeball centre sits proud of the surface, in eye radii. */
  protrude?: number
  mouth: { x: number; y: number; w: number; depth?: number; thick?: number; open?: boolean }
  cheeks?: { x: number; y: number; r: number }[]
  cheekColor?: string
}

export interface FaceRig {
  eyes: EyeRig[]
  mouth: THREE.Object3D
  group: THREE.Group
}

export interface SharedFace {
  white: THREE.SphereGeometry
  iris: THREE.SphereGeometry
  pupil: THREE.SphereGeometry
  glint: THREE.SphereGeometry
  whiteMat: THREE.MeshPhysicalMaterial
  irisMat: THREE.MeshPhysicalMaterial
  pupilMat: THREE.MeshPhysicalMaterial
  glintMat: THREE.MeshBasicMaterial
  mouthMat: THREE.MeshPhysicalMaterial
  mouthInMat: THREE.MeshPhysicalMaterial
  tongueMat: THREE.MeshPhysicalMaterial
  blushTex: THREE.Texture | null
}

export function sharedFace(kit: Kit): SharedFace {
  // Unit-radius eye parts, scaled per eye. Caps are built around +Y then
  // turned to face +Z so they hug the eyeball exactly.
  const white = kit.geo(new THREE.SphereGeometry(1, 48, 32))
  const iris = kit.geo(new THREE.SphereGeometry(1.012, 48, 16, 0, Math.PI * 2, 0, 0.66))
  iris.rotateX(Math.PI / 2)
  const pupil = kit.geo(new THREE.SphereGeometry(1.02, 48, 12, 0, Math.PI * 2, 0, 0.4))
  pupil.rotateX(Math.PI / 2)
  const glint = kit.geo(new THREE.SphereGeometry(1, 16, 12))
  return {
    white,
    iris,
    pupil,
    glint,
    whiteMat: kit.physical('eye-white', { color: '#FFFFFF', roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.9 }),
    irisMat: kit.physical('eye-iris', { color: '#3A2116', roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1 }),
    pupilMat: kit.physical('eye-pupil', { color: '#0E0908', roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1 }),
    glintMat: kit.material(new THREE.MeshBasicMaterial({ color: '#FFFFFF', toneMapped: false })),
    mouthMat: kit.physical('mouth', { color: '#3B1712', roughness: 0.35, clearcoat: 0.6 }),
    mouthInMat: kit.physical('mouth-in', { color: '#4A140F', roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.1, side: THREE.DoubleSide }),
    tongueMat: kit.physical('tongue', { color: '#FF6B7A', roughness: 0.35, clearcoat: 0.6, side: THREE.DoubleSide }),
    blushTex: radialTexture(kit, 0.35),
  }
}

function surfaceNormal(f: (x: number, y: number) => number, x: number, y: number): THREE.Vector3 {
  const e = 0.004
  const dx = (f(x + e, y) - f(x - e, y)) / (2 * e)
  const dy = (f(x, y + e) - f(x, y - e)) / (2 * e)
  return new THREE.Vector3(-dx, -dy, 1).normalize()
}

export function buildFace(kit: Kit, shared: SharedFace, spec: FaceSpec): FaceRig {
  const group = new THREE.Group()
  group.name = 'face'
  const protrude = spec.protrude ?? 0.3
  const eyes: EyeRig[] = spec.eyes.map((e) => {
    const n = surfaceNormal(spec.surfaceZ, e.x, e.y)
    const anchor = new THREE.Group()
    anchor.position.set(e.x, e.y, spec.surfaceZ(e.x, e.y)).addScaledVector(n, e.r * protrude)
    const lid = new THREE.Group()
    const baseScaleY = e.stretch ?? 1.12
    lid.scale.set(1, baseScaleY, 1)
    const ball = new THREE.Group()
    ball.rotation.order = 'YXZ'
    const white = new THREE.Mesh(shared.white, shared.whiteMat)
    white.scale.setScalar(e.r)
    const iris = new THREE.Mesh(shared.iris, shared.irisMat)
    iris.scale.setScalar(e.r)
    const pupil = new THREE.Mesh(shared.pupil, shared.pupilMat)
    pupil.scale.setScalar(e.r)
    const glint = new THREE.Mesh(shared.glint, shared.glintMat)
    glint.scale.setScalar(e.r * 0.2)
    glint.position.set(-0.3, 0.34, 0.92).normalize().multiplyScalar(e.r * 1.02)
    const glint2 = new THREE.Mesh(shared.glint, shared.glintMat)
    glint2.scale.setScalar(e.r * 0.09)
    glint2.position.set(0.24, -0.2, 0.95).normalize().multiplyScalar(e.r * 1.02)
    for (const m of [white, iris, pupil]) m.castShadow = true
    ball.add(white, iris, pupil, glint, glint2)
    lid.add(ball)
    anchor.add(lid)
    group.add(anchor)
    return { anchor, lid, ball, baseScaleY }
  })

  const { x: mx, y: my, w, depth = 0.38, thick = 0.019, open = false } = spec.mouth
  const mouth = new THREE.Group()
  if (open) {
    // Open "D" grin with a tongue, conformed to the surface.
    const h = w * 0.5
    const shape = new THREE.Shape()
    shape.moveTo(-w / 2, 0)
    shape.quadraticCurveTo(0, -w * 0.07, w / 2, 0)
    shape.bezierCurveTo(w / 2 + w * 0.02, -h * 1.35, -w / 2 - w * 0.02, -h * 1.35, -w / 2, 0)
    const conform = (geo: THREE.BufferGeometry, lift: number) => {
      const p = geo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + mx
        const y = p.getY(i) + my
        p.setXYZ(i, p.getX(i), p.getY(i), spec.surfaceZ(x, y) + lift)
      }
      geo.computeVertexNormals()
      return geo
    }
    const lip = kit.geo(conform(new THREE.ShapeGeometry(shape, 24), 0.006))
    const inside = new THREE.Mesh(lip, shared.mouthInMat)
    const tongueShape = new THREE.Shape()
    tongueShape.absellipse(0, -h * 0.78, w * 0.24, h * 0.24, 0, Math.PI * 2, false, 0)
    const tongue = new THREE.Mesh(kit.geo(conform(new THREE.ShapeGeometry(tongueShape, 24), 0.009)), shared.tongueMat)
    mouth.position.set(mx, my, 0)
    mouth.add(inside, tongue)
  } else {
    // Smile: a tube that follows the surface, with rounded end caps.
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 16; i++) {
      const u = (i / 16) * 2 - 1
      const x = mx + (u * w) / 2
      const y = my - (1 - u * u) * w * depth * 0.5
      pts.push(new THREE.Vector3(x, y, spec.surfaceZ(x, y) + thick * 0.35))
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    const tube = new THREE.Mesh(kit.geo(new THREE.TubeGeometry(curve, 32, thick, 10, false)), shared.mouthMat)
    const capGeo = kit.geo(new THREE.SphereGeometry(thick, 12, 8))
    const capA = new THREE.Mesh(capGeo, shared.mouthMat)
    capA.position.copy(pts[0]!)
    const capB = new THREE.Mesh(capGeo, shared.mouthMat)
    capB.position.copy(pts[pts.length - 1]!)
    // Pivot the mouth group on the smile centre so scaling it stays in place.
    const centre = new THREE.Vector3(mx, my - w * depth * 0.25, spec.surfaceZ(mx, my))
    mouth.position.copy(centre)
    for (const m of [tube, capA, capB]) {
      m.position.sub(centre)
      mouth.add(m)
    }
  }
  group.add(mouth)

  if (spec.cheeks && shared.blushTex) {
    const mat = kit.material(
      new THREE.MeshBasicMaterial({
        map: shared.blushTex,
        color: spec.cheekColor ?? '#FF6F7D',
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    )
    const geo = kit.geo(new THREE.PlaneGeometry(1, 1))
    for (const c of spec.cheeks) {
      const n = surfaceNormal(spec.surfaceZ, c.x, c.y)
      const m = new THREE.Mesh(geo, mat)
      m.scale.set(c.r * 2, c.r * 1.3, 1)
      m.position.set(c.x, c.y, spec.surfaceZ(c.x, c.y) + 0.006)
      m.lookAt(m.position.clone().add(n))
      m.renderOrder = 2
      group.add(m)
    }
  }
  return { eyes, mouth, group }
}

/* ------------------------------------------------------------------ */
/* Limbs                                                               */
/* ------------------------------------------------------------------ */

export interface LimbShared {
  arm: THREE.CapsuleGeometry
  hand: THREE.SphereGeometry
  leg: THREE.CapsuleGeometry
  foot: THREE.SphereGeometry
}

export function sharedLimbs(kit: Kit): LimbShared {
  return {
    arm: kit.geo(new THREE.CapsuleGeometry(0.036, 0.16, 8, 16)),
    hand: kit.geo(new THREE.SphereGeometry(0.052, 20, 14)),
    leg: kit.geo(new THREE.CapsuleGeometry(0.045, 0.1, 8, 16)),
    foot: kit.geo(new THREE.SphereGeometry(0.075, 24, 16)),
  }
}

/** Returns arm pivots placed at the shoulders (index 0 = screen-left). */
export function addArms(parent: THREE.Object3D, limbs: LimbShared, mat: THREE.Material, shoulders: Array<[number, number, number]>): THREE.Group[] {
  return shoulders.map(([x, y, z]) => {
    const pivot = new THREE.Group()
    pivot.position.set(x, y, z)
    const arm = new THREE.Mesh(limbs.arm, mat)
    arm.position.y = -0.1
    const hand = new THREE.Mesh(limbs.hand, mat)
    hand.position.y = -0.2
    arm.castShadow = hand.castShadow = true
    pivot.add(arm, hand)
    pivot.userData.side = Math.sign(x) || 1
    parent.add(pivot)
    return pivot
  })
}

/** Stubby legs from `hipY` down to the ground, with rounded feet. */
export function addLegs(parent: THREE.Object3D, limbs: LimbShared, mat: THREE.Material, xs: number[], hipY: number, z = 0): THREE.Object3D[] {
  return xs.map((x) => {
    const leg = new THREE.Group()
    const shin = new THREE.Mesh(limbs.leg, mat)
    const len = Math.max(0.02, hipY - 0.05)
    shin.scale.set(1, len / 0.19, 1)
    shin.position.set(x, 0.05 + len / 2, z)
    const foot = new THREE.Mesh(limbs.foot, mat)
    foot.scale.set(1.05, 0.62, 1.35)
    foot.position.set(x * 1.08, 0.045, z + 0.035)
    shin.castShadow = foot.castShadow = true
    leg.add(shin, foot)
    parent.add(leg)
    return leg
  })
}

/* ------------------------------------------------------------------ */
/* Colour + soft-body helpers                                          */
/* ------------------------------------------------------------------ */

/** Writes a vertex colour attribute from a per-position function. */
export function paint(geo: THREE.BufferGeometry, fn: (p: THREE.Vector3, out: THREE.Color) => void): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const cols = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    fn(p, c)
    cols[i * 3] = c.r
    cols[i * 3 + 1] = c.g
    cols[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3))
  return geo
}

/**
 * A soft "pillow" slab from a closed 2D outline (in XY): rounded edge all
 * round, gently domed faces. `t` passed to colour is 0 at the rim → 1 at the
 * centre of a face, so crusts/rims are easy to paint.
 */
export function pillow(
  outline: THREE.Vector2[],
  opts: { halfThick: number; edge: number; dome: number },
  color?: (t: number, out: THREE.Color) => void,
): THREE.BufferGeometry {
  const c = outline.reduce((a, p) => a.add(p), new THREE.Vector2()).multiplyScalar(1 / outline.length)
  const { halfThick: zt, edge: ue, dome } = opts
  // profile (u = fraction toward centre, z)
  const prof: Array<[number, number, number]> = []
  const R = 10
  const D = 12
  const half: Array<[number, number, number]> = []
  for (let i = 0; i <= R; i++) {
    const a = (i / R) * (Math.PI / 2)
    half.push([ue * (1 - Math.cos(a)), zt * Math.sin(a), (i / R) * 0.35])
  }
  for (let i = 1; i <= D; i++) {
    const s = i / D
    half.push([ue + (1 - ue) * s, zt + dome * (1 - (1 - s) * (1 - s)), 0.35 + 0.65 * s])
  }
  for (let i = half.length - 1; i >= 1; i--) {
    const h = half[i]!
    prof.push([h[0], -h[1], h[2]])
  }
  for (const h of half) prof.push(h)
  const n = outline.length
  const positions: number[] = []
  const colors: number[] = []
  const col = new THREE.Color()
  for (const [u, z, t] of prof) {
    for (let j = 0; j < n; j++) {
      const p = outline[j]!
      positions.push(c.x + (p.x - c.x) * (1 - u), c.y + (p.y - c.y) * (1 - u), z)
      if (color) {
        color(t, col)
        colors.push(col.r, col.g, col.b)
      }
    }
  }
  const idx: number[] = []
  for (let i = 0; i < prof.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j
      const b = (i + 1) * n + j
      const a1 = i * n + ((j + 1) % n)
      const b1 = (i + 1) * n + ((j + 1) % n)
      idx.push(a, a1, b, b, a1, b1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}
