'use client'
import { Component, type ReactNode } from 'react'

// The selection marker the editor frame puts around every block of the page
// being edited (handed to PageRenderer as context.editorMarker; live pages
// never render it). `display: contents`, so it adds no box and the page lays
// out exactly as live. It is also a per-block error boundary: a half-typed
// field that breaks one block shows a thin placeholder there instead of
// blanking the page. The boundary resets whenever the block's content changes
// (a new render from the editor), so fixing the field brings it back.

export function BlockMarker({ id, type, children }: { id: string; type: string; children: ReactNode }) {
  return (
    <div data-sv-block={id} data-sv-type={type} style={{ display: 'contents' }}>
      <MarkerBoundary>{children}</MarkerBoundary>
    </div>
  )
}

interface State { failed: boolean; children: ReactNode }

class MarkerBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, children: this.props.children }

  static getDerivedStateFromProps(props: { children: ReactNode }, state: State): Partial<State> | null {
    return props.children !== state.children ? { failed: false, children: props.children } : null
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div data-sv-block-failed="" role="note" style={{
        margin: '0.5rem clamp(1rem, 4vw, 2rem)', padding: '1rem', borderRadius: 12,
        border: '1px dashed var(--servd-mute)', color: 'var(--servd-mute)', background: 'var(--servd-bg)',
        font: '500 0.85rem/1.4 var(--font-inter), system-ui, sans-serif', textAlign: 'center',
      }}>
        This element can&apos;t be drawn yet
      </div>
    )
  }
}
