// 语音相关的纯工具（无 React、无副作用）
/** 录音优先顺序：webm/opus 最省流量，Safari 退 mp4，部分浏览器退 ogg */
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/ogg;codecs=opus',
  'audio/ogg',
]

export function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const mime of AUDIO_MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      /* 个别浏览器会抛，忽略继续试下一个 */
    }
  }
  return ''
}

/** 录音计时：0:07 / 1:02 */
export function formatRecordTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`
}
