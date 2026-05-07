'use client'
import { useEffect, useRef, useState } from 'react'
import { useKdsStore } from '../store/kds'
import { useKdsActions } from './useKdsSocket'
import type { Order } from '../lib/api'

type SpeechRecognitionAPI = new () => {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> & { length: number } }) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
}

interface VoiceState {
  active: boolean
  lastCommand: string | null
  lastError: string | null
}

/**
 * Web Speech API hook — listens for KDS commands like:
 *   "bump 47" "hold 23" "fire 12" "recall 8"
 * Numbers refer to the last 5 chars of the order ID (the visible ticket #).
 *
 * Falls back to no-op if the browser doesn't support SpeechRecognition.
 */
export function useKdsVoice(): VoiceState {
  const enabled = useKdsStore((s) => s.voiceEnabled)
  const orders = useKdsStore((s) => s.orders)
  const ordersRef = useRef(orders)
  ordersRef.current = orders

  const actions = useKdsActions()
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  const [active, setActive] = useState(false)
  const [lastCommand, setLastCommand] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    const win = window as unknown as { SpeechRecognition?: SpeechRecognitionAPI; webkitSpeechRecognition?: SpeechRecognitionAPI }
    const SR = win.SpeechRecognition ?? win.webkitSpeechRecognition
    if (!SR) {
      setLastError('Voice control not supported in this browser')
      return
    }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = 'en-US'

    rec.onresult = (event) => {
      const last = event.results[event.results.length - 1]
      if (!last) return
      const transcript = (last[0]?.transcript ?? '').toLowerCase().trim()
      if (!transcript) return
      setLastCommand(transcript)
      handleCommand(transcript, ordersRef.current, actionsRef.current).then((ok) => {
        if (!ok) setLastError(`Heard: "${transcript}" — no match`)
        else setLastError(null)
      })
    }

    rec.onerror = () => setLastError('Voice error — restarting')
    rec.onend = () => {
      // Auto-restart while toggle is on (Chrome auto-stops every ~60s)
      if (useKdsStore.getState().voiceEnabled) {
        try { rec.start() } catch { /* already started */ }
      } else {
        setActive(false)
      }
    }

    try {
      rec.start()
      setActive(true)
      setLastError(null)
    } catch {
      setLastError('Failed to start voice recognition')
    }

    return () => {
      try { rec.stop() } catch { /* */ }
      setActive(false)
    }
  }, [enabled])

  return { active, lastCommand, lastError }
}

const ACTION_WORDS: Record<string, 'bump' | 'hold' | 'fire' | 'recall'> = {
  bump: 'bump', bumped: 'bump', done: 'bump', complete: 'bump', completed: 'bump',
  hold: 'hold', pause: 'hold', wait: 'hold',
  fire: 'fire', start: 'fire', begin: 'fire', go: 'fire',
  recall: 'recall', undo: 'recall', back: 'recall',
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
}

function digitsFromTranscript(t: string): string {
  // Map number words to digits, then keep only digits + uppercase letters
  let s = t
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), digit)
  }
  return s.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

async function handleCommand(
  transcript: string,
  orders: Order[],
  actions: ReturnType<typeof useKdsActions>,
): Promise<boolean> {
  // Find action word
  let action: 'bump' | 'hold' | 'fire' | 'recall' | null = null
  for (const word of Object.keys(ACTION_WORDS)) {
    if (transcript.includes(word)) { action = ACTION_WORDS[word]!; break }
  }
  if (!action) return false

  // Extract ticket suffix (digits)
  const digits = digitsFromTranscript(transcript)
  if (!digits) return false

  // Find an active item whose order ID ends in the spoken digits.
  // Pick the most-recently-placed match in case multiple orders share a suffix.
  const candidates = orders.filter((o) => o.id.slice(-digits.length).toUpperCase() === digits)
  if (candidates.length === 0) return false

  candidates.sort((a, b) => +new Date(b.placedAt) - +new Date(a.placedAt))
  const target = candidates[0]!
  // Find the first non-bumped item — voice ops bump items individually
  const item = target.items.find((i) => !['bumped', 'voided'].includes(i.status))
  if (!item) return false

  await actions[action](item.id).catch(() => null)
  return true
}
