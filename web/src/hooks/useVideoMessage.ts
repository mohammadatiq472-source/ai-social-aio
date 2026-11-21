// 视频消息：本地抽封面 → 传视频（进度）→ 传封面 → 发 parts；失败可重试、可取消。
// 从 Composer 抽出来：组件只负责选文件与渲染进度卡片。
import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { api, ApiError } from '../api'
import type { Attachment, LocalMessage, MessagePart, Notify } from '../types'
import { MAX_VIDEO_BYTES } from '../parts'
import { extractPoster } from '../lib/video'

/** 视频上传的 Content-Type：优先后端支持的 file.type，再按扩展名兜底 */
export function videoMimeOf(file: File): string {
  const type = String(file.type || '').toLowerCase()
  if (type === 'video/mp4' || type === 'video/webm' || type === 'video/quicktime') return type
  const name = String(file.name || '').toLowerCase()
  if (name.endsWith('.webm')) return 'video/webm'
  if (name.endsWith('.mov')) return 'video/quicktime'
  return 'video/mp4'
}
import type { PosterInfo } from '../lib/video'

interface PendingVideo {
  file: File
  status: 'poster' | 'uploading' | 'failed'
  /** 视频本体上传进度 0..100 */
  progress: number
  error?: string
  poster?: PosterInfo | null
  /** 已经传完的视频附件：重试时跳过重复上传 */
  uploaded?: Attachment
}

interface Options {
  disabled: boolean
  /** 录音中不允许发视频 */
  recording: boolean
  uploadingRef: MutableRefObject<boolean>
  notify: Notify
  textRef: MutableRefObject<string>
  keptMentionsOf: (body: string) => number[]
  clearDraft: (focusInput?: boolean) => void
  replyTo: LocalMessage | null
  onSend: (body: string, mentions: number[], replyToSeq: number | null, parts?: MessagePart[]) => void
}

export function useVideoMessage({
  disabled,
  recording,
  uploadingRef,
  notify,
  textRef,
  keptMentionsOf,
  clearDraft,
  replyTo,
  onSend,
}: Options) {
  const [videoPending, setVideoPending] = useState<PendingVideo | null>(null)
  const videoTokenRef = useRef(0)
  const videoAbortRef = useRef<AbortController | null>(null)
  const replyToRef = useRef(replyTo)
  replyToRef.current = replyTo
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend

  const runVideoUpload = useCallback(
    async (seed: PendingVideo) => {
      const token = ++videoTokenRef.current
      const abort = new AbortController()
      videoAbortRef.current = abort
      uploadingRef.current = true
      setVideoPending({ ...seed, status: seed.uploaded ? 'uploading' : 'poster', error: undefined, progress: seed.uploaded ? 100 : 0 })

      try {
        // 1) 抽封面（失败不影响发送，只是没有静帧）
        let poster = seed.poster
        if (poster === undefined) {
          poster = await extractPoster(seed.file)
          if (token !== videoTokenRef.current) return
        }
        if (token !== videoTokenRef.current) return
        setVideoPending((prev) => (prev ? { ...prev, poster, status: 'uploading' } : prev))

        // 2) 传视频本体（进度条）
        let uploaded = seed.uploaded
        if (!uploaded) {
          // [外部评审前端 §4-4] 不能硬编码 video/mp4：服务端按真实 Content-Type 校验，
          // 选 .mov/.webm 会被 415 拒掉，而且提示完全不提原因。透传浏览器给的 file.type，
          // 缺类型时按扩展名兜底（少数录屏/老浏览器 file.type 为空）。
          const res = await api.uploadAttachment(seed.file, videoMimeOf(seed.file), {
            durationMs: poster?.durationMs && poster.durationMs > 0 ? poster.durationMs : undefined,
            signal: abort.signal,
            onProgress: (loaded, total) => {
              if (token !== videoTokenRef.current) return
              const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0
              setVideoPending((prev) => (prev && prev.status === 'uploading' ? { ...prev, progress: pct } : prev))
            },
          })
          if (token !== videoTokenRef.current) return
          uploaded = res.attachment
          setVideoPending((prev) => (prev ? { ...prev, uploaded, progress: 100 } : prev))
        }

        // 3) 传封面（单独一张图，服务端按 image 存）
        let posterId: number | undefined
        let posterUrlValue: string | null = null
        if (poster) {
          const posterRes = await api.uploadAttachment(poster.blob, 'image/jpeg', { signal: abort.signal })
          if (token !== videoTokenRef.current) return
          posterId = posterRes.attachment.id
          posterUrlValue = posterRes.attachment.url ?? null
        }
        if (token !== videoTokenRef.current) return

        // 4) 发消息
        const body = textRef.current.trim()
        const parts: MessagePart[] = []
        if (body) parts.push({ type: 'text', text: body })
        parts.push({
          type: 'video',
          attachmentId: uploaded.id,
          posterAttachmentId: posterId,
          url: uploaded.url,
          posterUrl: posterUrlValue,
          mime: uploaded.mime,
          bytes: uploaded.bytes,
          durationMs: uploaded.durationMs ?? poster?.durationMs ?? null,
        })
        onSendRef.current(body, keptMentionsOf(body), replyToRef.current?.seq ?? null, parts)
        clearDraft(false)
        if (token === videoTokenRef.current) {
          videoAbortRef.current = null
          uploadingRef.current = false
          setVideoPending(null)
        }
      } catch (err) {
        if (token !== videoTokenRef.current) return
        if ((err as Error).name === 'AbortError') {
          uploadingRef.current = false
          videoAbortRef.current = null
          setVideoPending(null)
          return
        }
        if (err instanceof ApiError && err.code === 'unauthorized') {
          uploadingRef.current = false
          videoAbortRef.current = null
          setVideoPending(null)
          return
        }
        uploadingRef.current = false
        videoAbortRef.current = null
        setVideoPending((prev) =>
          prev ? { ...prev, status: 'failed', error: err instanceof ApiError ? err.message : '网络异常，请重试' } : prev,
        )
      }
    },
    [clearDraft, keptMentionsOf, textRef, uploadingRef],
  )

  const startVideoUpload = useCallback(
    (file: File) => {
      if (disabled || uploadingRef.current || recording) return
      const mime = (file.type || '').toLowerCase()
      if (!mime.startsWith('video/')) {
        notify('请选择视频文件', 'error')
        return
      }
      if (file.size > MAX_VIDEO_BYTES) {
        notify('视频最大 40MB，请压缩或截短后再发', 'error')
        return
      }
      void runVideoUpload({ file, status: 'poster', progress: 0 })
    },
    [disabled, notify, recording, runVideoUpload, uploadingRef],
  )

  const cancelVideoUpload = useCallback(() => {
    videoTokenRef.current += 1
    videoAbortRef.current?.abort()
    videoAbortRef.current = null
    uploadingRef.current = false
    setVideoPending(null)
  }, [uploadingRef])

  const retryVideoUpload = useCallback(() => {
    if (!videoPending || videoPending.status !== 'failed') return
    void runVideoUpload({ ...videoPending, status: 'poster', progress: videoPending.uploaded ? 100 : 0 })
  }, [runVideoUpload, videoPending])

  return { videoPending, startVideoUpload, cancelVideoUpload, retryVideoUpload }
}
