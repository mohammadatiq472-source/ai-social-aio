// 语音录制：MediaRecorder 状态机 + 上传 + 上滑取消手势。
// 从 Composer 抽出来：组件只负责按钮/面板，录制与上传的时序在这里。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, TouchEvent as ReactTouchEvent } from 'react'
import { api, ApiError } from '../api'
import type { LocalMessage, MessagePart, Notify } from '../types'
import { MAX_VOICE_BYTES, MAX_VOICE_MS } from '../parts'
import { pickAudioMime } from '../lib/voice'
import { stopVoice } from '../voicePlayer'

export interface RecordingState {
  startedAt: number
  elapsedMs: number
  /** 上滑到取消区 */
  cancelArmed: boolean
}

interface PendingVoice {
  blob: Blob
  mime: string
  durationMs: number
  status: 'uploading' | 'failed'
}

interface Options {
  disabled: boolean
  notify: Notify
  /** 和图片/视频共用：上传中禁止再发 */
  uploadingRef: MutableRefObject<boolean>
  replyTo: LocalMessage | null
  /** 录完并上传成功后把 voice 段交给发送 */
  onSendParts: (parts: MessagePart[]) => void
}

export function useVoiceRecorder({ disabled, notify, uploadingRef, replyTo, onSendParts }: Options) {
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const [voicePending, setVoicePending] = useState<PendingVoice | null>(null)

  const mountedRef = useRef(true)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const recordStartRef = useRef(0)
  const recordTimerRef = useRef<number | null>(null)
  const recordAutoStopRef = useRef<number | null>(null)
  const recordCancelledRef = useRef(false)
  const recordTouchYRef = useRef<number | null>(null)
  const startingRecordRef = useRef(false)
  const voiceTokenRef = useRef(0)
  const replyToRef = useRef(replyTo)
  replyToRef.current = replyTo

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearRecordTimers = useCallback(() => {
    if (recordTimerRef.current != null) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (recordAutoStopRef.current != null) {
      window.clearTimeout(recordAutoStopRef.current)
      recordAutoStopRef.current = null
    }
  }, [])

  const releaseStream = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    if (!stream) return
    try {
      for (const track of stream.getTracks()) track.stop()
    } catch {
      /* 忽略 */
    }
  }, [])

  const uploadVoice = useCallback(
    async (blob: Blob, mime: string, durationMs: number) => {
      if (disabled) return
      const token = ++voiceTokenRef.current
      uploadingRef.current = true
      setVoicePending({ blob, mime, durationMs, status: 'uploading' })
      try {
        const res = await api.uploadAttachment(blob, mime, { durationMs })
        if (!mountedRef.current || token !== voiceTokenRef.current) return
        const attachment = res.attachment
        const parts: MessagePart[] = [
          {
            type: 'voice',
            attachmentId: attachment.id,
            url: attachment.url,
            mime: attachment.mime,
            bytes: attachment.bytes,
            durationMs: attachment.durationMs ?? durationMs,
          },
        ]
        onSendParts(parts)
        setVoicePending(null)
      } catch (err) {
        if (!mountedRef.current || token !== voiceTokenRef.current) return
        if (err instanceof ApiError && err.code === 'unauthorized') {
          setVoicePending(null)
          return
        }
        setVoicePending((prev) => (prev ? { ...prev, status: 'failed' } : prev))
        notify(`语音发送失败：${err instanceof ApiError ? err.message : '请重试'}`, 'error')
      } finally {
        if (voiceTokenRef.current === token) uploadingRef.current = false
      }
    },
    [disabled, notify, onSendParts, uploadingRef],
  )

  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current
    // Content-Type 只带主类型，不要 `;codecs=opus`（服务端按主类型白名单校验）
    const rawMime = recorder?.mimeType || 'audio/webm'
    const mime = rawMime.split(';')[0].trim() || 'audio/webm'
    const durationMs = Math.min(MAX_VOICE_MS, Math.max(0, Date.now() - recordStartRef.current))
    const chunks = chunksRef.current

    recorderRef.current = null
    chunksRef.current = []
    clearRecordTimers()
    releaseStream()
    setRecording(null)

    const cancelled = recordCancelledRef.current
    recordCancelledRef.current = false
    if (cancelled) return

    const blob = new Blob(chunks, { type: mime })
    if (blob.size === 0) {
      notify('没有录到声音，请重试', 'error')
      return
    }
    if (durationMs < 500) {
      notify('录音太短了', 'info')
      return
    }
    if (blob.size > MAX_VOICE_BYTES) {
      notify('语音超过 8MB，请缩短后重录', 'error')
      return
    }
    await uploadVoice(blob, mime, durationMs)
  }, [clearRecordTimers, notify, releaseStream, uploadVoice])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    clearRecordTimers()
    try {
      recorder.stop()
    } catch {
      /* 忽略：onstop 可能已经跑过 */
    }
  }, [clearRecordTimers])

  const startRecording = useCallback(async () => {
    if (disabled || recording || uploadingRef.current || startingRecordRef.current) return
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      notify('这个浏览器不支持录音', 'error')
      return
    }

    startingRecordRef.current = true
    try {
      // 录音时先把正在播的语音停掉，避免把播放声录进去
      stopVoice()

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        const name = (err as DOMException | undefined)?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          notify('没有麦克风权限，无法录音', 'error')
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          notify('没有找到麦克风设备', 'error')
        } else if (name === 'NotReadableError') {
          notify('麦克风被其他程序占用', 'error')
        } else {
          notify('无法启动录音，请检查麦克风', 'error')
        }
        return
      }

      const preferred = pickAudioMime()
      let recorder: MediaRecorder | null = null
      try {
        recorder = preferred
          ? new MediaRecorder(stream, { mimeType: preferred, audioBitsPerSecond: 32000 })
          : new MediaRecorder(stream)
      } catch {
        try {
          recorder = new MediaRecorder(stream)
        } catch {
          recorder = null
        }
      }
      if (!recorder) {
        for (const track of stream.getTracks()) track.stop()
        notify('这个浏览器无法录制语音', 'error')
        return
      }

      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      recordCancelledRef.current = false
      recordStartRef.current = Date.now()

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        void finishRecording()
      }
      recorder.onerror = () => {
        notify('录音出错了，请重试', 'error')
        recordCancelledRef.current = true
        stopRecording()
      }

      try {
        recorder.start(250)
      } catch {
        recorderRef.current = null
        for (const track of stream.getTracks()) track.stop()
        streamRef.current = null
        notify('无法开始录音', 'error')
        return
      }

      setRecording({ startedAt: recordStartRef.current, elapsedMs: 0, cancelArmed: false })
      clearRecordTimers()
      recordTimerRef.current = window.setInterval(() => {
        setRecording((prev) => (prev ? { ...prev, elapsedMs: Date.now() - recordStartRef.current } : prev))
      }, 100)
      // 60 秒自动停
      recordAutoStopRef.current = window.setTimeout(() => {
        recordAutoStopRef.current = null
        stopRecording()
      }, MAX_VOICE_MS)
    } finally {
      startingRecordRef.current = false
    }
  }, [clearRecordTimers, disabled, finishRecording, notify, recording, stopRecording, uploadingRef])

  const cancelRecording = useCallback(() => {
    recordCancelledRef.current = true
    recordTouchYRef.current = null
    if (recorderRef.current) {
      stopRecording()
      return
    }
    // 权限/启动阶段还没建好 recorder：直接复位界面
    clearRecordTimers()
    releaseStream()
    setRecording(null)
  }, [clearRecordTimers, releaseStream, stopRecording])

  const retryVoice = useCallback(() => {
    if (!voicePending || voicePending.status !== 'failed') return
    void uploadVoice(voicePending.blob, voicePending.mime, voicePending.durationMs)
  }, [uploadVoice, voicePending])

  const cancelVoicePending = useCallback(() => {
    voiceTokenRef.current += 1
    uploadingRef.current = false
    setVoicePending(null)
  }, [uploadingRef])

  // 上滑取消手势（移动端）
  const handleRecTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (touch) recordTouchYRef.current = touch.clientY
  }, [])

  const handleRecTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const start = recordTouchYRef.current
    const touch = event.touches[0]
    if (start == null || !touch) return
    const armed = touch.clientY - start < -50
    setRecording((prev) => (prev && prev.cancelArmed !== armed ? { ...prev, cancelArmed: armed } : prev))
  }, [])

  const handleRecTouchEnd = useCallback(() => {
    const armed = recording?.cancelArmed === true
    recordTouchYRef.current = null
    if (armed) cancelRecording()
  }, [cancelRecording, recording])

  return {
    recording,
    voicePending,
    startRecording,
    stopRecording,
    cancelRecording,
    retryVoice,
    cancelVoicePending,
    handleRecTouchStart,
    handleRecTouchMove,
    handleRecTouchEnd,
  }
}
