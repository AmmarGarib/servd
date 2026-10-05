'use client'
import { useEffect, useRef, useState } from 'react'

// Interactive WebGL "smokey" aurora background — the glowing wave ripples
// toward the cursor. Themed via `color` (defaults to servd deep purple).
//
// Reworked from the source component so the GL context initialises ONCE: mouse
// + hover live in a ref and are read inside the render loop, instead of the
// original which re-created the whole WebGL program on every pointer move.
// Fails closed (renders nothing visible) when WebGL is unavailable.

interface SmokeyBackgroundProps {
  color?: string
  className?: string
  backdropBlur?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
}

const BLUR: Record<NonNullable<SmokeyBackgroundProps['backdropBlur']>, string> = {
  none: 'backdrop-blur-none', sm: 'backdrop-blur-sm', md: 'backdrop-blur-md',
  lg: 'backdrop-blur-lg', xl: 'backdrop-blur-xl', '2xl': 'backdrop-blur-2xl', '3xl': 'backdrop-blur-3xl',
}

const VERTEX_SRC = `
  attribute vec4 a_position;
  void main() { gl_Position = a_position; }
`

const FRAGMENT_SRC = `
precision mediump float;
uniform vec2 iResolution;
uniform float iTime;
uniform vec2 iMouse;
uniform vec3 u_color;

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 centeredUV = (2.0 * fragCoord - iResolution.xy) / min(iResolution.x, iResolution.y);
  float time = iTime * 0.5;
  vec2 mouse = iMouse / iResolution;
  vec2 rippleCenter = 2.0 * mouse - 1.0;
  vec2 distortion = centeredUV;
  for (float i = 1.0; i < 8.0; i++) {
    distortion.x += 0.5 / i * cos(i * 2.0 * distortion.y + time + rippleCenter.x * 3.1415);
    distortion.y += 0.5 / i * cos(i * 2.0 * distortion.x + time + rippleCenter.y * 3.1415);
  }
  float wave = abs(sin(distortion.x + distortion.y + time));
  float glow = smoothstep(0.9, 0.2, wave);
  fragColor = vec4(u_color * glow, 1.0);
}

void main() { mainImage(gl_FragColor, gl_FragCoord.xy); }
`

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

export function SmokeyBackground({ color = '#5c3458', className = '', backdropBlur = 'sm' }: SmokeyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouse = useRef({ x: 0, y: 0, hovering: false })
  // Hidden until the shader program links: a device that can't run it (no
  // WebGL, or a compile failure) shows the page's solid background instead of
  // a blank white canvas over white-text inputs.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl')
    if (!gl) { console.warn('WebGL not supported — smokey background disabled'); return }

    const compile = (type: number, src: string): WebGLShader | null => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, src)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader))
        gl.deleteShader(shader)
        return null
      }
      return shader
    }

    const vert = compile(gl.VERTEX_SHADER, VERTEX_SRC)
    const frag = compile(gl.FRAGMENT_SHADER, FRAGMENT_SRC)
    if (!vert || !frag) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program))
      return
    }
    gl.useProgram(program)
    setReady(true)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'iResolution')
    const uTime = gl.getUniformLocation(program, 'iTime')
    const uMouse = gl.getUniformLocation(program, 'iMouse')
    const uColor = gl.getUniformLocation(program, 'u_color')

    const [r, g, b] = hexToRgb(color)
    gl.uniform3f(uColor, r, g, b)

    const start = Date.now()
    let raf = 0
    const render = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uTime, (Date.now() - start) / 1000)
      const mx = mouse.current.hovering ? mouse.current.x : w / 2
      const my = mouse.current.hovering ? h - mouse.current.y : h / 2
      gl.uniform2f(uMouse, mx, my)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      raf = requestAnimationFrame(render)
    }

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      mouse.current.x = e.clientX - rect.left
      mouse.current.y = e.clientY - rect.top
    }
    const onEnter = () => { mouse.current.hovering = true }
    const onLeave = () => { mouse.current.hovering = false }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseenter', onEnter)
    canvas.addEventListener('mouseleave', onLeave)

    render()
    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseenter', onEnter)
      canvas.removeEventListener('mouseleave', onLeave)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [color])

  return (
    <div className={`absolute inset-0 w-full h-full overflow-hidden ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full block" style={{ visibility: ready ? 'visible' : 'hidden' }} />
      <div className={`absolute inset-0 ${BLUR[backdropBlur]}`} />
    </div>
  )
}

export default SmokeyBackground
