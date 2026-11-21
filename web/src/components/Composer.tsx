import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { LocalMessage, Member, MessagePart } from '../types'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder'
import { useVideoMessage } from '../hooks/useVideoMessage'
import { useImageUpload } from '../hooks/useImageUpload'
import { cn } from '../utils'
import { normalizeParts, previewOf } from '../parts'
import { pushRecentSticker } from '../stickers'
import { StickerPanel } from './StickerPanel'
import { ComposerPlusPanel } from './composer/PlusPanel'
import { ComposerToolbar } from './composer/Toolbar'
import { ComposerUploadPreviews } from './composer/UploadPreviews'
import { ComposerReplyBar } from './composer/ReplyBar'
import { ComposerMentionPop } from './composer/MentionPop'
import { ComposerFilePickers } from './composer/FilePickers'
import { ComposerInputRow } from './composer/InputRow'
import {
  EMPTY_MENTION,
  MAX_LENGTH,
  detectMention,
  draftKey,
  firstImageFile,
  hasFileDrag,
} from './composer/input-helpers'
import type { MentionState } from './composer/input-helpers'

interface ComposerProps {
  conversationId: number
  members: Member[]
  replyTo: LocalMessage | null
  disabled?: boolean
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
  onCancelReply: () => void
  /** 输入时回调（父组件负责节流并告诉服务端「我在输入」；不传就不发 typing） */
  onTyping?: () => void
  /** parts 为空表示纯文本；发图/发表情时以 parts 为准。onDelivered 在服务端确认后回调（记「最近使用」） */
  onSend: (
    body: string,
    mentions: number[],
    replyToSeq: number | null,
    parts?: MessagePart[],
    onDelivered?: () => void,
  ) => void
}

/**
 * 输入栏的编排层：状态、事件、上传时序都留在这里。
 * 展示按职责拆到 ./composer/：Toolbar（＋/图片/表情/录音/发送）、InputRow（输入框或录音条）、
 * UploadPreviews（待发媒体卡片）、ReplyBar（引用条）、MentionPop（@ 补全浮层）、
 * FilePickers（三个隐藏 input）、PlusPanel（「＋」面板）、input-helpers（纯函数与常量）。
 * 上传时序按媒体分到 hooks/：useImageUpload（预览地址与在途作废令牌）、useVoiceRecorder、useVideoMessage，
 * 三者共用本组件的 uploadingRef 一把闸。
 * 拆分的边界是「有没有自己的状态」：有状态的留在 hook 或本文件，纯展示的搬出去。
 */
export function Composer({ conversationId, members, replyTo, disabled, notify, onCancelReply, onSend, onTyping }: ComposerProps) {
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<number[]>([])
  const [mention, setMention] = useState<MentionState>(EMPTY_MENTION)
  const [activeIndex, setActiveIndex] = useState(0)
  // 语音：录完上传；失败保留 blob 可重发
  // 视频：抽封面 → 上传（进度条/可取消）→ 发送；失败保留卡片可重试
  const [stickerOpen, setStickerOpen] = useState(false)
  // 手机端「＋」面板（相册 / 拍摄 / 语音 / 表情）；桌面端不显示这个按钮
  const [plusOpen, setPlusOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const textRef = useRef('')
  const mentionsRef = useRef<number[]>([])
  const uploadingRef = useRef(false)

  const voice = useVoiceRecorder({
    disabled: Boolean(disabled),
    notify,
    uploadingRef,
    replyTo,
    onSendParts: (parts) => onSend('', [], replyTo?.seq ?? null, parts),
  })

  const video = useVideoMessage({
    disabled: Boolean(disabled),
    recording: voice.recording != null,
    uploadingRef,
    notify,
    textRef,
    keptMentionsOf: (body) => keptMentionsOf(body),
    clearDraft: (focusInput = false) => clearDraft(focusInput),
    replyTo,
    onSend: (body, mentions, replyToSeq, parts) => onSend(body, mentions, replyToSeq, parts),
  })

  // 图片：选好先本地预览 + 上传，成功后再发消息；失败保留预览可重试（预览地址与作废令牌都在 hook 里）
  const image = useImageUpload({
    disabled: Boolean(disabled),
    recording: voice.recording != null,
    uploadingRef,
    notify,
    textRef,
    keptMentionsOf: (body) => keptMentionsOf(body),
    clearDraft: (focusInput = false) => clearDraft(focusInput),
    replyTo,
    onSend: (body, mentions, replyToSeq, parts) => onSend(body, mentions, replyToSeq, parts),
    closePlusPanel: () => setPlusOpen(false),
    closeStickerPanel: () => setStickerOpen(false),
  })

  // 录音相关（用 ref 存，不触发重渲染的都在这里）

  useEffect(() => {
    textRef.current = text
  }, [text])
  useEffect(() => {
    mentionsRef.current = mentions
  }, [mentions])
  useEffect(() => {
    return () => {
      // 离开时把在途上传 / 麦克风收掉，别让录音在后台继续
      // （图片预览地址与在途作废由 useImageUpload 自己的卸载清理负责）
      video.cancelVideoUpload()
      voice.cancelRecording()
    }
    // 只跑一次：video/voice 的回调内部都用 ref，捕获首帧引用是安全的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换会话：切换草稿；发送后清空。上传/录音中的内容属于旧会话，直接丢弃
  useEffect(() => {
    setText(window.localStorage.getItem(draftKey(conversationId)) ?? '')
    setMentions([])
    setMention(EMPTY_MENTION)
    image.cancelUpload()
    video.cancelVideoUpload()
    voice.cancelRecording()
    voice.cancelVoicePending()
    setPlusOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [text])

  // 表情面板：点外面 / Esc 关闭（包管理弹窗里的点击与 Esc 不算）
  useEffect(() => {
    if (!stickerOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (!target) return
      if (target.closest('.sticker-panel') || target.closest('.composer__tool--sticker') || target.closest('.modal-mask')) {
        return
      }
      setStickerOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 包详情/新建弹窗自己有 Esc，先让它关，不要连带收起面板
      if (document.querySelector('.modal-mask')) return
      setStickerOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [stickerOpen])

  // @ 补全弹出时收起表情面板，避免两个浮层叠在一起
  useEffect(() => {
    if (mention.active) setStickerOpen(false)
  }, [mention.active])

  // 「＋」面板：Esc / 点面板外（消息区）收起
  useEffect(() => {
    if (!plusOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePlusPanel(true)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target) return
      // 输入栏内部（＋ / 输入框 / 发送）各自处理，不在这里关
      if (target.closest('.composer')) return
      closePlusPanel()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [plusOpen])

  /* ---------------- 手机端「＋」面板 ---------------- */

  function openPlusPanel() {
    setStickerOpen(false)
    setMention(EMPTY_MENTION)
    setPlusOpen(true)
    // 展开面板时先收起软键盘（对齐微信：面板和键盘互斥）
    textareaRef.current?.blur()
  }

  /** focusInput=true 表示「回到键盘输入」（点 ⌨ 或发完消息） */
  function closePlusPanel(focusInput = false) {
    setPlusOpen(false)
    if (!focusInput) return
    window.setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      try {
        el.setSelectionRange(end, end)
      } catch {
        /* 忽略 */
      }
    }, 0)
  }

  function togglePlusPanel() {
    if (plusOpen) closePlusPanel(true)
    else openPlusPanel()
  }

  function pickFromGallery() {
    closePlusPanel()
    fileInputRef.current?.click()
  }

  function pickFromCamera() {
    closePlusPanel()
    cameraInputRef.current?.click()
  }

  function startVoiceFromPanel() {
    closePlusPanel()
    setStickerOpen(false)
    void voice.startRecording()
  }

  function openStickersFromPanel() {
    closePlusPanel()
    setStickerOpen(true)
  }

  const matches = useMemo(() => {
    if (!mention.active) return []
    const keyword = mention.query.trim().toLowerCase()
    return members
      .filter((member) => !keyword || member.displayName.toLowerCase().includes(keyword))
      .slice(0, 8)
  }, [mention.active, mention.query, members])

  useEffect(() => {
    setActiveIndex(0)
  }, [mention.active, mention.query])

  function updateDraft(next: string) {
    setText(next)
    if (next.trim()) window.localStorage.setItem(draftKey(conversationId), next)
    else window.localStorage.removeItem(draftKey(conversationId))
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value
    const caret = event.target.selectionStart ?? next.length
    updateDraft(next)
    setMention(detectMention(next, caret))
    // 只在真的输入了字时才发 typing：删除到空、或者只按了方向键不该让别人看到「正在输入」
    if (next.trim()) onTyping?.()
  }

  function pickMember(member: Member) {
    const el = textareaRef.current
    const before = text.slice(0, mention.atIndex)
    const after = text.slice(mention.caret)
    const inserted = `@${member.displayName} `
    const next = `${before}${inserted}${after}`
    updateDraft(next)
    setMentions((prev) => (prev.includes(member.id) ? prev : [...prev, member.id]))
    setMention(EMPTY_MENTION)
    const caret = before.length + inserted.length
    window.requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  function keptMentionsOf(body: string): number[] {
    // 只保留正文里仍然带着 @昵称 的成员，避免删除文本后残留 mentions
    return mentionsRef.current.filter((id) => {
      const member = members.find((item) => item.id === id)
      return member ? body.includes(`@${member.displayName}`) : false
    })
  }

  function clearDraft(focusInput = true) {
    setText('')
    setMentions([])
    setMention(EMPTY_MENTION)
    window.localStorage.removeItem(draftKey(conversationId))
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      // 发图/发表情后不要把手机键盘顶起来
      if (focusInput) textareaRef.current.focus()
    }
  }

  function submit() {
    // 上传中 / 录音中禁止重复提交
    if (uploadingRef.current || voice.recording) return
    const body = text.trim()
    if (!body || disabled) return
    onSend(body, keptMentionsOf(body), replyTo?.seq ?? null)
    clearDraft()
    setPlusOpen(false)
  }

  function sendSticker(pack: string, key: string) {
    if (disabled || uploadingRef.current || voice.recording) return
    const parts: MessagePart[] = [{ type: 'sticker', pack, key }]
    // 服务端确认「发出去了」才写「最近使用」（失败的消息不进最近）
    onSend('', [], replyTo?.seq ?? null, parts, () => pushRecentSticker(pack, key))
    setStickerOpen(false)
    setPlusOpen(false)
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    if (file) void image.startUpload(file)
  }

  function handleVideoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void video.startVideoUpload(file)
  }

  /** 点输入框：收起「＋」面板；手机上把输入框顶进可视区（iOS 的 100dvh 不会立刻变化） */
  function handleInputFocus() {
    if (plusOpen) setPlusOpen(false)
    const el = textareaRef.current
    if (!el || !window.matchMedia('(max-width: 760px)').matches) return
    window.setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 280)
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const file = firstImageFile(event.clipboardData?.files)
    if (!file) return
    event.preventDefault()
    void image.startUpload(file)
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDragActive(false)
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.dataTransfer) return
    event.preventDefault()
    setDragActive(false)
    const file = firstImageFile(event.dataTransfer.files)
    if (file) void image.startUpload(file)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法组字中不拦截回车
    if (event.nativeEvent.isComposing) return

    if (mention.active && matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((prev) => (prev + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((prev) => (prev - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        pickMember(matches[activeIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(EMPTY_MENTION)
        return
      }
    }

    if (event.key === 'Escape' && replyTo) {
      event.preventDefault()
      onCancelReply()
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const uploading = image.pending?.status === 'uploading'
  const voiceUploading = voice.voicePending?.status === 'uploading'
  const busy = uploading || voiceUploading
  const isRecording = voice.recording != null
  const replyPreview = replyTo
    ? previewOf(normalizeParts(replyTo.parts, replyTo.body), replyTo.body).slice(0, 24)
    : ''

  return (
    <div
      className={cn(
        'composer',
        dragActive && 'composer--drop',
        plusOpen && 'composer--panel',
        isRecording && 'composer--recording',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? <div className="composer__drop-hint">松开即可发送图片</div> : null}

      {replyTo ? <ComposerReplyBar senderName={replyTo.senderName} preview={replyPreview} onCancel={onCancelReply} /> : null}

      <ComposerUploadPreviews
        image={image.pending}
        video={video.videoPending}
        voice={voice.voicePending}
        onRetryImage={(file) => void image.startUpload(file)}
        onCancelImage={image.cancelUpload}
        onRetryVideo={video.retryVideoUpload}
        onCancelVideo={video.cancelVideoUpload}
        onRetryVoice={voice.retryVoice}
        onCancelVoice={voice.cancelVoicePending}
      />

      {stickerOpen ? (
        <StickerPanel
          conversationId={conversationId}
          notify={notify}
          onSend={sendSticker}
          onClose={() => setStickerOpen(false)}
        />
      ) : null}

      {mention.active ? (
        <ComposerMentionPop
          query={mention.query}
          matches={matches}
          activeIndex={activeIndex}
          onActivate={setActiveIndex}
          onPick={pickMember}
        />
      ) : null}

      <ComposerToolbar
        plusOpen={plusOpen}
        stickerOpen={stickerOpen}
        recording={isRecording}
        disabled={Boolean(disabled)}
        busy={busy}
        text={text}
        onTogglePlus={togglePlusPanel}
        onPickImage={() => fileInputRef.current?.click()}
        onToggleSticker={() => setStickerOpen((prev) => !prev)}
        onToggleMic={() => {
          if (isRecording) voice.stopRecording()
          else void voice.startRecording()
        }}
        onSend={submit}
      >
        <ComposerInputRow
          recording={voice.recording}
          inputRef={textareaRef}
          text={text}
          disabled={disabled}
          maxLength={MAX_LENGTH}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={handleInputFocus}
          onRecTouchStart={voice.handleRecTouchStart}
          onRecTouchMove={voice.handleRecTouchMove}
          onRecTouchEnd={voice.handleRecTouchEnd}
          onCancelRecording={voice.cancelRecording}
        />
      </ComposerToolbar>

      <ComposerPlusPanel
        open={plusOpen}
        disabled={Boolean(disabled)}
        busy={busy}
        recording={isRecording}
        onGallery={pickFromGallery}
        onCamera={pickFromCamera}
        onVoice={startVoiceFromPanel}
        onVideo={() => {
          setPlusOpen(false)
          window.setTimeout(() => videoInputRef.current?.click(), 0)
        }}
        onStickers={openStickersFromPanel}
      />

      <ComposerFilePickers
        galleryRef={fileInputRef}
        cameraRef={cameraInputRef}
        videoRef={videoInputRef}
        onImageChange={handleFileChange}
        onVideoChange={handleVideoFileChange}
      />

      <p className="composer__hint">Enter 发送 · Shift+Enter 换行 · @ 点名</p>
    </div>
  )
}
