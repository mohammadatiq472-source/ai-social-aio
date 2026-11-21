// 视频：本地抽一帧做封面（纯 DOM，不依赖 React）
export interface PosterInfo {
  blob: Blob
  width: number
  height: number
  durationMs: number
}

/** 从视频文件抽一张封面；失败返回 null（发送时不带封面，不阻塞） */
export function extractPoster(file: File): Promise<PosterInfo | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    let settled = false
    const done = (value: PosterInfo | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = window.setTimeout(() => done(null), 8000)
    video.onerror = () => {
      window.clearTimeout(timer)
      done(null)
    }
    video.onloadeddata = () => {
      try {
        // 取靠前的一帧，避免黑场
        video.currentTime = Math.min(0.15, Math.max(0, (video.duration || 1) * 0.05))
      } catch {
        /* 某些浏览器不允许立即 seek，onerror/超时会兜底 */
      }
    }
    video.onseeked = () => {
      window.clearTimeout(timer)
      const w = video.videoWidth || 0
      const h = video.videoHeight || 0
      if (!w || !h) return done(null)
      const scale = Math.min(1, 720 / w)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return done(null)
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      } catch {
        return done(null)
      }
      canvas.toBlob(
        (blob) => {
          if (!blob) return done(null)
          done({ blob, width: canvas.width, height: canvas.height, durationMs: Math.round((video.duration || 0) * 1000) })
        },
        'image/jpeg',
        0.82,
      )
    }
    video.src = url
  })
}
