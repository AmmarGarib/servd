'use client'
import { useKdsStore } from '../../store/kds'
import { useKdsVoice } from '../../hooks/useKdsVoice'

interface KdsHeaderProps {
  title: string
  stationId?: string
}

export function KdsHeader({ title, stationId }: KdsHeaderProps) {
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
    <header className="flex h-14 items-center justify-between border-b border-kds-border bg-kds-card px-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold tracking-wide text-kds-text">{title}</h1>
        <span className="rounded-full bg-kds-red px-2.5 py-0.5 text-sm font-bold text-white">
          {activeOrders.length}
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
            onClick={() => setLang('en')}
            className={`px-3 py-1.5 transition-colors ${lang === 'en' ? 'bg-kds-green text-black' : 'text-kds-subtext hover:text-kds-text'}`}
          >
            EN
          </button>
          <button
            onClick={() => setLang('ur')}
            className={`px-3 py-1.5 transition-colors border-l border-kds-border ${lang === 'ur' ? 'bg-kds-green text-black' : 'text-kds-subtext hover:text-kds-text'}`}
            style={{ fontFamily: 'sans-serif' }}
          >
            اردو
          </button>
        </div>

        {/* Image toggle */}
        <button
          onClick={() => setShowImages(!showImages)}
          title={showImages ? 'Hide item images' : 'Show item images'}
          className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
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
          className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
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
          className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
            voiceEnabled
              ? 'border-kds-amber bg-kds-amber text-black'
              : 'border-kds-border text-kds-subtext hover:text-kds-text'
          }`}
        >
          🎙
        </button>

        <div className="flex items-center gap-4 text-xs text-kds-subtext">
          <span>{new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}</span>
          <a href="/dashboard" className="hover:text-kds-text">← Dashboard</a>
        </div>
      </div>
    </header>
  )
}
