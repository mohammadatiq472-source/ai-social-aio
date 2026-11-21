// 语音播放器：全局只允许一条在播。
// 组件通过 useVoicePlayer() 订阅「当前在播的 key / 播放进度」，豆荚按 key 判断自己是否在播。

import { useEffect, useState } from 'react'

export interface VoicePlayerState {
  /** 当前挂载的语音 key（v:<attachmentId>） */
  key: string | null
  playing: boolean
  currentMs: number
  totalMs: number
  error: string | null
}

const IDLE: VoicePlayerState = { key: null, playing: false, currentMs: 0, totalMs: 0, error: null }

let audio: HTMLAudioElement | null = null
let state: VoicePlayerState = IDLE
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(patch: Partial<VoicePlayerState>): void {
  state = { ...state, ...patch }
  emit()
}

function ensureAudio(): HTMLAudioElement | null {
  if (audio) return audio
  if (typeof Audio === 'undefined') return null
  const el = new Audio()
  el.preload = 'metadata'
  el.addEventListener('timeupdate', () => {
    if (!state.key) return
    setState({ currentMs: Math.round(el.currentTime * 1000) })
  })
  el.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setState({ totalMs: Math.round(el.duration * 1000) })
    }
  })
  el.addEventListener('play', () => setState({ playing: true }))
  el.addEventListener('pause', () => {
    if (!el.ended) setState({ playing: false })
  })
  el.addEventListener('ended', () => setState({ playing: false, currentMs: 0 }))
  el.addEventListener('error', () => {
    // stopVoice() 清空 src 时也可能触发 error，没有在播条目就忽略
    if (!state.key) return
    setState({ playing: false, error: '语音加载失败' })
  })
  audio = el
  return el
}

export function getVoiceState(): VoicePlayerState {
  return state
}

export function subscribeVoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 点一条语音：同一条切播放/暂停，不同条则换源并从头播（保证同一时刻只有一条在播） */
export function toggleVoice(key: string, url: string, fallbackDurationMs?: number | null): void {
  const el = ensureAudio()
  if (!el) return

  if (state.key === key && el.src) {
    if (state.playing) {
      el.pause()
      setState({ playing: false })
      return
    }
    if (el.ended || state.currentMs >= state.totalMs - 60) el.currentTime = 0
    void el
      .play()
      .then(() => setState({ playing: true, error: null }))
      .catch(() => setState({ playing: false, error: '播放失败' }))
    return
  }

  try {
    el.pause()
  } catch {
    /* 忽略：切源前暂停失败不影响后续 */
  }
  el.src = url
  try {
    el.currentTime = 0
  } catch {
    /* 个别浏览器在元数据到达前设置 currentTime 会抛，忽略即可 */
  }
  setState({
    key,
    playing: false,
    currentMs: 0,
    totalMs: typeof fallbackDurationMs === 'number' && fallbackDurationMs > 0 ? fallbackDurationMs : 0,
    error: null,
  })
  void el
    .play()
    .then(() => setState({ playing: true, error: null }))
    .catch(() => setState({ playing: false, error: '播放失败' }))
}

/** 停止并清空（切会话 / 卸载时调用，避免后台一直响） */
export function stopVoice(): void {
  if (audio) {
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {
      /* 忽略 */
    }
  }
  state = IDLE
  emit()
}

export function useVoicePlayer(): VoicePlayerState {
  const [snapshot, setSnapshot] = useState<VoicePlayerState>(getVoiceState)
  useEffect(() => {
    setSnapshot(getVoiceState())
    return subscribeVoice(() => setSnapshot(getVoiceState()))
  }, [])
  return snapshot
}
