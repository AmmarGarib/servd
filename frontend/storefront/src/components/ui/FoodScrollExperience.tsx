'use client'
// servd food-scroll experience — a self-contained WebGL band. As you scroll
// through it, the camera flies forward through a field of floating food images
// over a deep servd-purple "space", with a drifting star field. Recoloured from
// the original cosmic hero to the servd palette (#3A0E69 royal purple, bone,
// a single orange spark) and seeded with food imagery.
//
// Admin-editable: pass `images` (URLs from the SiteLayout CMS slug
// `servd:home-experience`); falls back to placeholder food photos until the
// operator sets their own. No GSAP / postprocessing / custom shaders — kept
// dependency-light and robust. Honours prefers-reduced-motion with a static
// food grid. Mounted via next/dynamic(ssr:false), so three never hits SSR.

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

// Placeholder food photos (Unsplash, CORS-enabled for WebGL textures). Swapped
// out the moment the operator adds images in the admin block editor.
const PLACEHOLDER_FOODS = [
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=640&q=70&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=640&q=70&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=640&q=70&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=640&q=70&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=640&q=70&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=640&q=70&auto=format&fit=crop',
]

interface Props {
  images?: string[]
  heading?: string
  sublines?: string[]
}

export default function FoodScrollExperience({
  images,
  heading = 'servd',
  sublines = ['real kitchens, no middlemen', 'fresh · fast · yours'],
}: Props) {
  const imgs = images && images.length > 0 ? images : PLACEHOLDER_FOODS
  const sectionRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progressRef = useRef(0)
  const [mode, setMode] = useState<'webgl' | 'static'>('webgl')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    let lostContext = false
    const canvas = canvasRef.current
    const section = sectionRef.current
    if (reduced || !canvas || !section) { setMode('static'); return }

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    } catch { setMode('static'); return }
    canvas.addEventListener('webglcontextlost', () => { lostContext = true; setMode('static') })

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x0e0618, 0.0016)
    const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2000)
    camera.position.set(0, 0, 120)
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // ── Star field — bone / purple / a few orange sparks, on the purple dark.
    const starCount = 1400
    const positions = new Float32Array(starCount * 3)
    const colors = new Float32Array(starCount * 3)
    const palette = [new THREE.Color(0xede6d3), new THREE.Color(0x8b5cf6), new THREE.Color(0x6d28d9), new THREE.Color(0xe94e1b)]
    for (let i = 0; i < starCount; i++) {
      const r = 120 + Math.random() * 700
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(Math.random() * 2 - 1)
      positions[i * 3] = r * Math.sin(ph) * Math.cos(th)
      positions[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th)
      positions[i * 3 + 2] = -Math.random() * 900
      const c = palette[Math.random() < 0.12 ? 3 : Math.floor(Math.random() * 3)] ?? palette[0]!
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 2.2, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }))
    scene.add(stars)

    // ── Soft purple glow backdrop.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 900),
      new THREE.MeshBasicMaterial({ color: 0x3a0e69, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    glow.position.z = -700
    scene.add(glow)

    // ── Food planes the camera flies through. Purple fallback tile until the
    // texture loads (or if it fails / is CORS-blocked).
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    const planes: THREE.Mesh[] = []
    const count = Math.min(imgs.length, 10)
    const spacing = 120
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x4c1d95, transparent: true, opacity: 0.98, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), mat)
      const angle = i * 1.15
      const radius = 42 + (i % 3) * 16
      mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.55, -40 - i * spacing)
      mesh.userData['baseZ'] = mesh.position.z
      scene.add(mesh)
      planes.push(mesh)
      const url = imgs[i % imgs.length]!
      loader.load(
        url,
        (tex) => { tex.colorSpace = THREE.SRGBColorSpace; mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true },
        undefined,
        () => { /* keep the purple fallback tile */ },
      )
    }
    const lastZ = -40 - (count - 1) * spacing
    const flyRange = 120 - (lastZ - 90) // camera travels from z=120 to just past the last plane

    let raf = 0
    const render = () => {
      raf = requestAnimationFrame(render)
      const t = performance.now() * 0.001
      const p = progressRef.current
      camera.position.z = 120 - p * flyRange
      camera.position.x = Math.sin(t * 0.1) * 3
      camera.position.y = Math.cos(t * 0.12) * 2
      stars.rotation.y = t * 0.012
      stars.rotation.x = t * 0.005
      for (let i = 0; i < planes.length; i++) {
        const m = planes[i]!
        m.rotation.z = Math.sin(t * 0.25 + i) * 0.06
        m.lookAt(camera.position) // billboard toward the camera
      }
      if (!lostContext) renderer.render(scene, camera)
    }
    render()

    const onScroll = () => {
      const rect = section.getBoundingClientRect()
      const total = rect.height - window.innerHeight
      const scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1))
      const p = total > 0 ? scrolled / total : 0
      progressRef.current = p
      setProgress(p)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      starGeo.dispose()
      ;(stars.material as THREE.Material).dispose()
      glow.geometry.dispose(); (glow.material as THREE.Material).dispose()
      planes.forEach((m) => {
        m.geometry.dispose()
        const mat = m.material as THREE.MeshBasicMaterial
        mat.map?.dispose()
        mat.dispose()
      })
      renderer.dispose()
    }
  }, [imgs])

  return (
    <section ref={sectionRef} aria-label="servd — the food" style={{ position: 'relative', height: '320vh', background: '#0E0618' }}>
      <div style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'hidden' }}>
        {mode === 'webgl' ? (
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
        ) : (
          // Reduced-motion / no-WebGL fallback: a calm food mosaic on purple.
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px', opacity: 0.5 }}>
            {imgs.slice(0, 9).map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ))}
          </div>
        )}

        {/* Overlay copy — bone on purple, single orange spark. */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '2rem', pointerEvents: 'none' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, color: '#EDE6D3', fontSize: 'clamp(2.5rem, 9vw, 7rem)', letterSpacing: '-0.03em', lineHeight: 0.95, textShadow: '0 8px 40px rgba(0,0,0,0.55)', margin: 0 }}>
            {heading}<span style={{ color: '#E94E1B' }}>.</span>
          </h2>
          {sublines.map((s, i) => (
            <p key={i} style={{ color: 'rgba(237,230,211,0.82)', fontSize: 'clamp(0.95rem, 2vw, 1.25rem)', fontWeight: 500, margin: '0.5rem 0 0', textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>{s}</p>
          ))}
        </div>

        {/* Scroll progress bar. */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '3px', background: 'rgba(237,230,211,0.12)' }}>
          <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: 'linear-gradient(90deg, #6D28D9, #E94E1B)', transition: 'width 0.1s linear' }} />
        </div>
      </div>
    </section>
  )
}
