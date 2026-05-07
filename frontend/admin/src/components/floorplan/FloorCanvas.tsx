'use client'

// FloorCanvas — shared SVG-based floor plan renderer used by both the editor
// and the live status view. Pure render logic; interaction handlers (drag,
// resize, click) are passed in by the consumer.

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

export interface FloorTable {
  id: string
  label: string
  capacity: number
  shape: 'rectangle' | 'square' | 'round' | 'banquette' | 'counter' | 'barstool'
  x: number; y: number; width: number; height: number; rotation: number
  status?: string
}

export interface FloorViewport {
  width: number
  height: number
  backgroundUrl?: string | null
}

interface Props {
  floor: FloorViewport
  tables: FloorTable[]
  selectedId?: string | null
  // colour resolver — consumer decides the tint based on status / business
  // logic. Returns CSS color string.
  colorFor: (t: FloorTable) => { fill: string; stroke: string; text: string }
  onTablePointerDown?: (t: FloorTable, e: React.PointerEvent<SVGGElement>) => void
  onTableClick?: (t: FloorTable) => void
  // 0 = no grid; otherwise grid spacing in px
  gridSize?: number
  // Decorations layered above the SVG (e.g. resize handles for selected table)
  overlay?: ReactNode
  ariaLabel?: string
}

export function FloorCanvas({
  floor, tables, selectedId, colorFor,
  onTablePointerDown, onTableClick, gridSize = 0, overlay, ariaLabel,
}: Props) {
  // Container resize observer to compute the viewport scale (so the floor
  // canvas always fits inside the column without distortion).
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? floor.width
      setScale(Math.min(1, w / floor.width))
    })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [floor.width])

  return (
    <div
      ref={wrapRef}
      style={{ width: '100%', position: 'relative' }}
      aria-label={ariaLabel ?? 'Floor plan'}
    >
      <svg
        viewBox={`0 0 ${floor.width} ${floor.height}`}
        width="100%"
        style={{
          display: 'block',
          background: floor.backgroundUrl ? `url(${floor.backgroundUrl}) center/cover` : '#fafafa',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: '0.75rem',
          touchAction: 'none',
          userSelect: 'none',
        }}
        role="application"
      >
        {gridSize > 0 && <Grid size={gridSize} width={floor.width} height={floor.height} />}

        {tables.map((t) => {
          const colors = colorFor(t)
          const isSel  = selectedId === t.id
          return (
            <g
              key={t.id}
              transform={`translate(${t.x} ${t.y}) rotate(${t.rotation} ${t.width / 2} ${t.height / 2})`}
              onPointerDown={(e) => onTablePointerDown?.(t, e)}
              onClick={() => onTableClick?.(t)}
              style={{ cursor: onTablePointerDown || onTableClick ? 'pointer' : 'default' }}
            >
              {renderShape(t, colors, isSel)}
              <text
                x={t.width / 2}
                y={t.height / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={Math.max(11, Math.min(t.width, t.height) * 0.18)}
                fontWeight={800}
                fill={colors.text}
                style={{ pointerEvents: 'none' }}
              >
                {t.label}
              </text>
              <text
                x={t.width / 2}
                y={t.height / 2 + Math.max(11, Math.min(t.width, t.height) * 0.18) * 0.85}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={Math.max(9, Math.min(t.width, t.height) * 0.12)}
                fontWeight={500}
                fill={colors.text}
                opacity={0.7}
                style={{ pointerEvents: 'none' }}
              >
                {t.capacity} seats
              </text>
            </g>
          )
        })}
      </svg>
      {/* Overlay (resize handles, etc.) — same coordinate space as SVG */}
      {overlay && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
          } as CSSProperties}
        >
          <div style={{
            transformOrigin: '0 0',
            transform: `scale(${scale})`,
            position: 'absolute',
            top: 0, left: 0,
            width: floor.width,
            height: floor.height,
          }}>
            {overlay}
          </div>
        </div>
      )}
    </div>
  )
}

function renderShape(t: FloorTable, c: { fill: string; stroke: string }, selected: boolean): ReactNode {
  const strokeWidth = selected ? 3 : 1.5
  const stroke = selected ? '#000' : c.stroke
  switch (t.shape) {
    case 'round':
      return <ellipse cx={t.width / 2} cy={t.height / 2} rx={t.width / 2} ry={t.height / 2} fill={c.fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'square':
    case 'rectangle':
      return <rect width={t.width} height={t.height} rx={6} ry={6} fill={c.fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'banquette':
      return <rect width={t.width} height={t.height} rx={t.height / 2} ry={t.height / 2} fill={c.fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'counter':
      return <rect width={t.width} height={t.height} rx={3} ry={3} fill={c.fill} stroke={stroke} strokeWidth={strokeWidth} />
    case 'barstool':
      return <circle cx={t.width / 2} cy={t.height / 2} r={Math.min(t.width, t.height) / 2} fill={c.fill} stroke={stroke} strokeWidth={strokeWidth} />
    default:
      return <rect width={t.width} height={t.height} rx={6} ry={6} fill={c.fill} stroke={stroke} strokeWidth={strokeWidth} />
  }
}

function Grid({ size, width, height }: { size: number; width: number; height: number }) {
  const lines: ReactNode[] = []
  for (let x = size; x < width; x += size) {
    lines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={height} stroke="rgba(0,0,0,0.04)" strokeWidth={1} />)
  }
  for (let y = size; y < height; y += size) {
    lines.push(<line key={`h${y}`} x1={0} y1={y} x2={width} y2={y} stroke="rgba(0,0,0,0.04)" strokeWidth={1} />)
  }
  return <g>{lines}</g>
}
