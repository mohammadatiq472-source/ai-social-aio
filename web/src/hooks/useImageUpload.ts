// 图片上传编排：本地预览地址的生命周期、在途上传的作废令牌、成功后转成消息 parts。
// 从 Composer 抽出来（2026-11-16 第二轮大组件拆分）：组件只剩「选文件 / 拖放 / 渲染待发卡片」，
// 上传时序全在这里。
//
// 三条不变量（动它之前先读，破了就是线上 bug）：
// 1) uploadingRef 是图片 / 语音 / 视频**共用的一把闸**，由 Composer 持有后传进来。
//    这里只置位与复位，绝不自己 new 一把——否则三路能同时上传，发送顺序与草稿清理就乱了。
// 2) token 只增不减：取消、切会话、卸载、开始新的一张都会 ++。
//    异步回调回来先比 token，不等就整段丢弃（既不改状态也不发消息），这是「取消后图片仍被发出去」的防线。
// 3) 预览地址先建后收：新 URL 建好、setPending 之后再 revoke 旧 URL。
//    反过来做，失败重试时会先闪一帧破图。卸载时只 revoke、不 setState。
import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { api, ApiError } from '../api'
import type { Attachment, LocalMessage, MessagePart, Notify } from '../types'
import { ALLOWED_IMAGE_MIMES, MAX_IMAGE_BYTES } from '../parts'

export interface PendingUpload {
  file: File
  mime: string
  localUrl: string
  status: 'uploading' | 'failed'
}

interface Options {
  disabled: boolean
  /** 录音中不允许再挑图（与上传中同一类闸） */
  recording: boolean
  /** 与 useVoiceRecorder / useVideoMessage 共用的闸 */
  uploadingRef: MutableRefObject<boolean>
  notify: Notify
  /** 发图时要把输入框里的正文（可能还没上屏到 state）一起带上 */
  textRef: MutableRefObject<string>
  keptMentionsOf: (body: string) => number[]
  clearDraft: (focusInput?: boolean) => void
  replyTo: LocalMessage | null
  onSend: (body: string, mentions: number[], replyToSeq: number | null, parts?: MessagePart[]) => void
  /** 通过前置闸就收「＋」面板：与原实现一致，格式不合法时面板也已经关掉 */
  closePlusPanel: () => void
  /** 预览卡片建好之后再收表情面板：保持原调用顺序，避免两个浮层同时挂载 */
  closeStickerPanel: () => void
}

export function useImageUpload({
  disabled,
  recording,
  uploadingRef,
  notify,
  textRef,
  keptMentionsOf,
  clearDraft,
  replyTo,
  onSend,
  closePlusPanel,
  closeStickerPanel,
}: Options) {
  const [pending, setPending] = useState<PendingUpload | null>(null)
  const uploadTokenRef = useRef(0)
  const objectUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  // 回调里要读最新的 props：这些函数每次渲染都会换身份，用 ref 兜住，避免异步返回时拿到首帧闭包
  const live = useRef({
    disabled,
    recording,
    notify,
    textRef,
    keptMentionsOf,
    clearDraft,
    replyTo,
    onSend,
    closePlusPanel,
    closeStickerPanel,
  })
  live.current = {
    disabled,
    recording,
    notify,
    textRef,
    keptMentionsOf,
    clearDraft,
    replyTo,
    onSend,
    closePlusPanel,
    closeStickerPanel,
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // 卸载：让所有在途上传的结果作废，并回收预览地址（此时不能 setState）
      uploadTokenRef.current += 1
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [])

  function revokeObjectUrl() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }

  /** 取消上传 / 切会话丢弃：作废在途结果、放掉共用闸、回收预览 */
  function cancelUpload() {
    uploadTokenRef.current += 1
    uploadingRef.current = false
    revokeObjectUrl()
    setPending(null)
  }

  function sendUploadedImage(attachment: Attachment) {
    const { textRef, onSend, keptMentionsOf, clearDraft, replyTo } = live.current
    const body = textRef.current.trim()
    const parts: MessagePart[] = []
    if (body) parts.push({ type: 'text', text: body })
    parts.push({
      type: 'image',
      attachmentId: attachment.id,
      url: attachment.url,
      // 气泡优先用缩略图（服务端派生成功才有）；灯箱/大图仍用 url 原图
      thumbUrl: attachment.thumbUrl,
      mime: attachment.mime,
      bytes: attachment.bytes,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
    })
    onSend(body, keptMentionsOf(body), replyTo?.seq ?? null, parts)
    clearDraft(false)
    setPending(null)
    revokeObjectUrl()
  }

  async function startUpload(file: File) {
    const { disabled, recording, notify, closePlusPanel, closeStickerPanel } = live.current
    if (disabled || uploadingRef.current || recording) return
    closePlusPanel()
    const mime = (file.type || '').toLowerCase()
    // 白名单与上限都在 parts.ts（协议常量），不引 components/ 里的包装，避免 hooks 反向依赖组件目录
    if (!(ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) {
      notify('只支持 JPG / PNG / WebP / GIF 图片', 'error')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify('图片最大 8MB，请压缩后再发', 'error')
      return
    }

    uploadingRef.current = true
    const token = ++uploadTokenRef.current
    // 先建新地址再回收旧地址，避免重试时预览闪一下破图
    const localUrl = URL.createObjectURL(file)
    const previousUrl = objectUrlRef.current
    objectUrlRef.current = localUrl
    setPending({ file, mime, localUrl, status: 'uploading' })
    closeStickerPanel()
    if (previousUrl) URL.revokeObjectURL(previousUrl)

    try {
      const res = await api.uploadAttachment(file, mime)
      // 取消 / 切会话 / 卸载都会让 token 变化，此时不能再发
      if (!mountedRef.current || token !== uploadTokenRef.current) return
      sendUploadedImage(res.attachment)
    } catch (err) {
      if (!mountedRef.current || token !== uploadTokenRef.current) return
      if (err instanceof ApiError && err.code === 'unauthorized') return
      const message = err instanceof ApiError ? err.message : '图片上传失败，请重试'
      setPending((prev) => (prev && prev.localUrl === localUrl ? { ...prev, status: 'failed' } : prev))
      live.current.notify(`上传失败：${message}`, 'error')
    } finally {
      if (uploadTokenRef.current === token) uploadingRef.current = false
    }
  }

  return { pending, startUpload, cancelUpload }
}
