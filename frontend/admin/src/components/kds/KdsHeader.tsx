'use client'
import { useKdsStore } from '../../store/kds'
import { useKdsVoice } from '../../hooks/useKdsVoice'
import { enableKdsSound, useKdsAudioState } from '../../hooks/useKdsSocket'

interface KdsHeaderProps {
  title: string
  stationId?: string
  /** The page's own queue count; when given it replaces the socket-store count so the two can never disagree. */
  count?: number
}

export function KdsHeader({ title, stationId, count }: KdsHeaderProps) {
  const audio = useKdsAudioState()
  const orders = useKdsStore((s) => s.orders)
  const lang = useKdsStore((s) => s.lang)
  const showImages = useKdsStore((s) => s.showImages)
  const soundEnabled = useKdsStore((s) => s.soundEnabled)
  const voiceEnabled = useKdsStore((s) => s.voiceEnabled)
  // F05: live socket health, set by the useKdsSocket hook elsewhere on the page.
  const wsConnected = useKdsStore((s) => s.wsConnected)
  const lastOrderAt = useKdsStore((s) => s.lastOrderAt)
  const setLang = useKdsStore((s) => s.setLang)
  const setShowImages = useKdsStore((s) => s.setShowImages)
  const setSoundEnabled = useKdsStore((s) => s.setSoundEnabled)
  const setVoiceEnabled = useKdsStore((s) => s.setVoiceEnabled)

  // Wire up speech recognition while voice toggle is on
  const voice = useKdsVoice()

  const activeOrders = stationId
    ? orders.filter((o) =>
        o.items.some(
          (i) => i.stationId === stationId && !['bumped', 'voided'].includes(i.status),
        ),
      )
    : orders.filter((o) => !['completed', 'cancelled'].includes(o.status))

  return (
    <>
    {soundEnabled && audio === 'suspended' && (
      <button type="button" onClick={enableKdsSound}
        className="flex min-h-11 w-full items-center justify-center gap-2 border-b border-kds-amber/40 bg-kds-amber/15 px-4 text-sm font-bold text-kds-amber">
        Tap to enable sound. New-order chimes stay silent until you do.
      </button>
    )}
    <header className="flex min-h-14 items-center justify-between border-b border-kds-border bg-kds-card px-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold tracking-wide text-kds-text">{title}</h1>
        <span className="rounded-full bg-kds-red px-2.5 py-0.5 text-sm font-bold text-white">
          {count ?? activeOrders.length}
        </span>
        {/* F05: WS health pill — green dot + "Live" when connected, pulsing red
            + "Reconnecting…" when the socket has dropped. Right of the count
            badge so the operator's eye lands on it next. */}
        <div className="flex items-center gap-1.5 ml-1" title={wsConnected ? 'Live updates connected' : 'Trying to reconnect — refresh if this persists'}>
          <span className={`h-2.5 w-2.5 rounded-full ${wsConnected ? 'bg-kds-green' : 'bg-kds-red animate-pulse'}`} />
          <span className="text-xs font-bold text-kds-subtext">
            {wsConnected ? 'Live' : 'Reconnecting…'}
          </span>
          {lastOrderAt && wsConnected && (
            <span className="text-xs text-kds-subtext ml-1">
              · last order {lastOrderAt.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        {voiceEnabled && voice.lastCommand && (
          <span className="rounded-md border border-kds-green/40 bg-kds-green/10 px-2 py-0.5 text-xs text-kds-green font-mono">
            🎙 {voice.lastCommand}
          </span>
        )}
        {voiceEnabled && voice.lastError && (
          <span className="text-xs text-kds-amber">{voice.lastError}</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Language toggle */}
        <div className="flex rounded-lg border border-kds-border overflow-hidden text-xs font-bold">
          <button
            onClick={() => setLang('en')} aria-pressed={lang === 'en'} aria-label="English"
            className={`min-h-11 min-w-11 px-3 transition-colors ${lang === 'en' ? 'bg-kds-green text-black' : 'text-kds-subtext hover:text-kds-text'}`}
          >
            EN
          </button>
          <button
            onClick={() => setLang('ur')} aria-pressed={lang === 'ur'} aria-label="Urdu"
            className={`min-h-11 min-w-11 px-3 transition-colors border-l border-kds-border ${lang === 'ur' ? 'bg-kds-green text-black' : 'text-kds-subtext hover:text-kds-text'}`}
            style={{ fontFamily: 'sans-serif' }}
          >
            اردو
          </button>
        </div>

        {/* Image toggle */}
        <button
          onClick={() => setShowImages(!showImages)}
          title={showImages ? 'Hide item images' : 'Show item images'}
          aria-label="Show item images" aria-pressed={showImages}
          className={`min-h-11 min-w-11 rounded-lg border px-3 text-xs font-bold transition-colors ${
            showImages
              ? 'border-kds-green bg-kds-green text-black'
              : 'border-kds-border text-kds-subtext hover:text-kds-text'
          }`}
        >
          🖼
        </button>

        {/* Sound toggle */}
        <button
          onClick={() => setSoundEnabled(!soundEnabled)}
          title={soundEnabled ? 'Mute new-order chime' : 'Unmute new-order chime'}
          aria-label="New-order chime" aria-pressed={soundEnabled}
          className={`min-h-11 min-w-11 rounded-lg border px-3 text-xs font-bold transition-colors ${
            soundEnabled
              ? 'border-kds-green bg-kds-green text-black'
              : 'border-kds-border text-kds-subtext hover:text-kds-text'
          }`}
        >
          {soundEnabled ? '🔔' : '🔕'}
        </button>

        {/* Voice control toggle */}
        <button
          onClick={() => setVoiceEnabled(!voiceEnabled)}
          title={voiceEnabled ? 'Disable voice control' : 'Enable voice control (say "bump 47", "hold 23", "fire 12")'}
          aria-label="Voice control" aria-pressed={voiceEnabled}
          className={`min-h-11 min-w-11 rounded-lg border px-3 text-xs font-bold transition-colors ${
            voiceEnabled
              ? 'border-kds-amber bg-kds-amber text-black'
              : 'border-kds-border text-kds-subtext hover:text-kds-text'
          }`}
        >
          🎙
        </button>

        <div className="flex items-center gap-4 text-xs text-kds-subtext">
          <span>{new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}</span>
          <a href="/w" className="hover:text-kds-text">← Workspace</a>
        </div>
      </div>
    </header>
    </>
  )
}
