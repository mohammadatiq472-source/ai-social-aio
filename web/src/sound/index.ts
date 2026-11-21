/**
 * AIO 音效管理器
 *
 * 素材全部来自 Freesound 的 CC0（公共领域）录音，已转成 96kbps 单声道 mp3、
 * 裁掉首尾静音并统一响度，放在 web/public/sounds/ 下：
 *   recv    收到消息   Elevator Ding                  fs:588718
 *   send    发送成功   Menu Selection Click           fs:171697
 *   mention 被 @ 提醒  High-Pitched Two-Note Notif.   fs:624598
 *   error   发送失败   Access Denied                  fs:249300
 * 详见 web/public/sounds/CREDITS.md。
 *
 * 设计要点：
 * - 元素常驻（每个 cue 一个 HTMLAudioElement），播放时只 seek 不重建；
 * - **不在模块初始化时预加载**：登录页也会加载这个模块，模块级 preload 会让 4 个 mp3
 *   （23.8KB / 4 个请求）跟首屏抢带宽。改为 `warmSounds()`，在首次用户手势
 *   （attachUnlockOnFirstGesture）或首次真正 play() 前调用；
 * - 浏览器 autoplay 策略：首次用户手势后解锁（attachUnlockOnFirstGesture），
 *   play() 被拒时静默记下来，解锁后补播一次；
 * - 同一 cue 300ms 内去抖，连发消息不会炸耳朵；
 * - 页面隐藏时不响，mention 例外（隐藏期间最多响一次）。
 */

export type SoundName = 'recv' | 'send' | 'mention' | 'error'

/** 四个 cue 的固定顺序，供预加载与外部遍历使用 */
export const SOUND_NAMES: readonly SoundName[] = ['recv', 'send', 'mention', 'error']

const STORAGE_KEY = 'qqmini.sound'
const DEBOUNCE_MS = 300
const BASE = import.meta.env.BASE_URL

export interface SoundSettings {
  muted: boolean
  volume: number
}

const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 1 }

const canPlay = typeof window !== 'undefined' && typeof Audio !== 'undefined'
const canStore = typeof localStorage !== 'undefined'

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.volume
  return Math.min(1, Math.max(0, n))
}

function loadSettings(): SoundSettings {
  if (!canStore) return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<SoundSettings> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
    return {
      muted: parsed.muted === true,
      volume: typeof parsed.volume === 'number' ? clamp01(parsed.volume) : DEFAULT_SETTINGS.volume,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function persist(): void {
  if (!canStore) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式/配额满：不因为存不上而影响播放
  }
}

let settings: SoundSettings = loadSettings()

/** 每个 cue 一个常驻元素，绝不每次 new */
const elements = new Map<SoundName, HTMLAudioElement>()
/** 上次播放时间戳，用于 300ms 去抖 */
const lastPlayed = new Map<SoundName, number>()
/** autoplay 被拦下、等待首次手势后补播的 cue */
const pendingRetry = new Set<SoundName>()

let unlocked = false
/** 页面隐藏期间 mention 是否已经响过（每个隐藏周期最多一次） */
let hiddenMentionPlayed = false

function soundUrl(name: SoundName): string {
  return `${BASE}sounds/${name}.mp3`
}

function ensure(name: SoundName): HTMLAudioElement | null {
  if (!canPlay) return null
  const existing = elements.get(name)
  if (existing) return existing
  try {
    const el = new Audio(soundUrl(name))
    el.preload = 'auto'
    el.volume = clamp01(settings.volume)
    // 只是预取，不播；load() 让浏览器尽早把 mp3 拉下来
    el.load()
    elements.set(name, el)
    return el
  } catch {
    return null
  }
}

/**
 * 预取 4 个 cue（幂等）。模块加载时**不**调用：登录页用不到声音，
 * 白白多 4 个 mp3 请求。首次用户手势（attachUnlockOnFirstGesture 的 unlock）
 * 会调它，play() 自己也会按需 ensure。
 */
export function warmSounds(): void {
  if (!canPlay) return
  for (const name of SOUND_NAMES) ensure(name)
}

// 页面隐藏/恢复只维护「隐藏期间 mention 最多响一次」的标记，不碰音频元素
if (canPlay && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') hiddenMentionPlayed = false
  })
}

/** 页面可见才响；mention 例外，隐藏期间最多响一次 */
function allowedByVisibility(name: SoundName): boolean {
  if (typeof document === 'undefined') return true
  if (document.visibilityState === 'visible') return true
  if (name !== 'mention') return false
  if (hiddenMentionPlayed) return false
  hiddenMentionPlayed = true
  return true
}

/**
 * 播放一个 cue。被去抖/静音/页面隐藏拦掉时静默返回，不抛错。
 */
export function play(name: SoundName): void {
  if (!canPlay || settings.muted) return

  const now = Date.now()
  const last = lastPlayed.get(name) ?? 0
  if (now - last < DEBOUNCE_MS) return

  if (!allowedByVisibility(name)) return

  const el = ensure(name)
  if (!el) return

  lastPlayed.set(name, now)
  try {
    el.currentTime = 0
  } catch {
    // 少数浏览器在 metadata 未就绪时不允许 seek，忽略即可
  }
  el.volume = clamp01(settings.volume)

  const started: Promise<void> | undefined = el.play()
  if (started && typeof started.catch === 'function') {
    started.catch(() => {
      // autoplay 被拦：撤销这次去抖记录，等首次手势后补播一次
      lastPlayed.set(name, 0)
      if (!unlocked) pendingRetry.add(name)
    })
  }
}

/** 便捷对象：sounds.recv() / sounds.mention() ... */
export const sounds: Record<SoundName, () => void> = {
  recv: () => play('recv'),
  send: () => play('send'),
  mention: () => play('mention'),
  error: () => play('error'),
}

export function setMuted(muted: boolean): void {
  settings = { ...settings, muted: muted === true }
  persist()
}

export function isMuted(): boolean {
  return settings.muted
}

export function toggleMuted(): boolean {
  setMuted(!settings.muted)
  return settings.muted
}

/** 0..1 主音量，越界会被夹住 */
export function setVolume(volume: number): void {
  const v = clamp01(volume)
  settings = { ...settings, volume: v }
  for (const el of elements.values()) el.volume = v
  persist()
}

export function getVolume(): number {
  return settings.volume
}

export function getSettings(): SoundSettings {
  return { ...settings }
}

/**
 * 在 App 里挂一次：首次用户手势（点击/触摸/按键）时解锁音频，
 * 并补播一次被 autoplay 策略拦下的 cue。返回解除监听的函数。
 */
export function attachUnlockOnFirstGesture(): () => void {
  if (!canPlay || typeof document === 'undefined') return () => {}

  const events = ['pointerdown', 'keydown', 'touchstart', 'click'] as const
  let done = false

  const cleanup = (): void => {
    for (const type of events) document.removeEventListener(type, unlock, true)
  }

  function unlock(): void {
    if (done) return
    done = true
    cleanup()
    unlocked = true

    // 首个手势是唯一可靠的「可以预取」时机（此时用户已经在页面上，不再跟首屏抢带宽）
    warmSounds()

    // 用 0 音量把每个元素跑一遍 play/pause：iOS/Safari 靠这一步才算真正解锁
    for (const el of elements.values()) {
      const restore = el.volume
      el.volume = 0
      const started: Promise<void> | undefined = el.play()
      if (started && typeof started.then === 'function') {
        started
          .then(() => {
            el.pause()
            try {
              el.currentTime = 0
            } catch {
              // 忽略
            }
            el.volume = restore
          })
          .catch(() => {
            el.volume = restore
          })
      } else {
        el.pause()
        el.volume = restore
      }
    }

    // 补播一次被拦下的 cue（通常就是进页面后收到的第一条消息）
    const first = pendingRetry.values().next().value
    pendingRetry.clear()
    if (first !== undefined) {
      lastPlayed.set(first, 0)
      play(first)
    }
  }

  for (const type of events) document.addEventListener(type, unlock, true)
  return cleanup
}

/** 供调试/设置页读取：素材地址 */
export function soundUrls(): Record<SoundName, string> {
  return {
    recv: soundUrl('recv'),
    send: soundUrl('send'),
    mention: soundUrl('mention'),
    error: soundUrl('error'),
  }
}
