import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Conversation, ImagePart, LocalMessage, Me } from '../types'
import { cn, formatClock, formatDayLabel, quoteOf } from '../utils'
import { normalizeParts, previewOf } from '../parts'
import { stickerSrc, useStickerPacks } from '../stickers'
import { stopVoice } from '../voicePlayer'
import { Avatar } from './Avatar'
import { Lightbox } from './Lightbox'
import { MessageActionSheet } from './MessageActionSheet'
import { MessageContent } from './MessageContent'

interface MessageListProps {
  me: Me
  conversation: Conversation | null
  messages: LocalMessage[]
  loading: boolean
  onRetry: (clientMsgId: string) => void
  onReply: (message: LocalMessage) => void
  /** 撤回自己的消息（父组件负责调接口 + 更新本地状态 + toast） */
  onRecallMessage: (message: LocalMessage) => void
  /** 举报消息（父组件负责调接口 + toast 409） */
  onReportMessage: (message: LocalMessage, reason: string) => void | Promise<void>
  /** 点头像看成员主页 */
  onOpenProfile?: (principalId: number) => void
  /** 从成员主页点某条消息：滚到该 seq */
  jumpSeq?: number | null
  onJumped?: () => void
  /** 谁正在输入（同一会话其他人的昵称）；空数组 = 不显示 */
  typingNames?: string[]
  /** 向上翻历史：返回本次加载条数（0 = 没有更早的了） */
  onLoadOlder?: () => Promise<number>
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

/** 长按多久弹菜单 */
const LONG_PRESS_MS = 500
/** 手指移动超过这个距离就认为是滚动，取消长按 */
const LONG_PRESS_MOVE_PX = 10

type PressEvent = ReactPointerEvent<HTMLDivElement>

function dayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 单条消息行的回调集合。
 *
 * 为什么要这一层：消息行是 memo 化的（见 MessageRow 的比较器），父组件每次渲染都会新建
 * 闭包/箭头函数；直接当 props 传下去，memo 每次都失效，等于没 memo（500 条消息时每条
 * 新消息都会全量重渲染）。所以父组件只传**身份稳定**的 handlers 对象，内部转发到最新闭包。
 */
interface RowHandlers {
  openProfile: (principalId: number) => void
  openMenu: (message: LocalMessage) => void
  reply: (message: LocalMessage) => void
  retry: (clientMsgId: string) => void
  jumpTo: (seq: number) => void
  openImage: (part: ImagePart) => void
  startPress: (message: LocalMessage, event: PressEvent) => void
  movePress: (event: PressEvent) => void
  clearPress: () => void
}

interface MessageRowProps {
  message: LocalMessage
  me: Me
  /** 这一天要不要打日分隔（父组件顺序扫描算出，行内不做跨行判断） */
  separator: string | null
  clock: string
  /** 这一分钟要不要打时间戳（父组件顺序扫描算出） */
  showStamp: boolean
  quoted: { name: string; text: string; found: boolean } | null
  highlighted: boolean
  canOpenProfile: boolean
  /** 表情地址解析：包列表加载完身份会变，行跟着刷新一次（自定义包的表情地址） */
  stickerUrl: (pack: string, key: string) => string | null
  /** 长按后吞掉紧随其后的 click（避免误触气泡内容） */
  suppressRef: { current: boolean }
  handlers: RowHandlers
}

/**
 * 单条消息行（memo）。
 * 只依赖 props：message 对象在 mergeMessages 里按 seq 去重，没变的行会保持同一个对象身份，
 * 因此新消息进来时只有新行 + 需要的行重渲染。
 */
function MessageRowBase({
  message,
  me,
  separator,
  clock,
  showStamp,
  quoted,
  highlighted,
  canOpenProfile,
  stickerUrl,
  suppressRef,
  handlers,
}: MessageRowProps) {
  const isMine = message.senderId === me.id
  const isAI = message.senderType === 'agent'
  const parts = normalizeParts(message.parts, message.body)
  const interactive = message.seq != null && !message.recalledAt

  // 只挂到文字气泡上的手势；图片/语音/表情不接管，保持各自逻辑
  const bubbleHandlers =
    message.seq == null || message.recalledAt
      ? undefined
      : {
          onPointerDown: (event: PressEvent) => handlers.startPress(message, event),
          onPointerMove: handlers.movePress,
          onPointerUp: handlers.clearPress,
          onPointerLeave: handlers.clearPress,
          onPointerCancel: handlers.clearPress,
          onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => {
            event.preventDefault()
            handlers.openMenu(message)
          },
        }

  return (
    <>
      {separator ? (
        <div className="day-sep">
          <span>{separator}</span>
        </div>
      ) : null}

      {message.kind === 'system' ? (
        // 事件反馈（表情包分享等）：居中灰字，不带头像、气泡、时间戳
        <div className="sys-notice" role="note">
          <span>{message.body}</span>
        </div>
      ) : message.recalledAt ? (
        <div className="msg-recalled" role="note">
          {isMine ? '你撤回了一条消息' : `${message.senderName} 撤回了一条消息`}
        </div>
      ) : (
        <div
          data-seq={message.seq ?? undefined}
          className={cn(
            'msg',
            isMine ? 'msg--mine' : 'msg--other',
            isAI && 'msg--ai',
            message.optimistic && 'msg--optimistic',
            message.failed && 'msg--failed',
            highlighted && 'msg--flash',
          )}
          onClickCapture={(event) => {
            if (!suppressRef.current) return
            event.stopPropagation()
            event.preventDefault()
          }}
        >
          {/* 头像永远排在 DOM 第一位：.msg--mine 用 row-reverse，
              所以自己的消息头像自然落在最右侧、气泡在其左边（微信/QQ 的行为） */}
          {canOpenProfile && message.seq != null ? (
            <button
              type="button"
              className="msg__avatar-btn"
              onClick={() => handlers.openProfile(message.senderId)}
              aria-label={`查看 ${isMine ? me.displayName : message.senderName} 的主页`}
              title={`查看 ${isMine ? me.displayName : message.senderName} 的主页`}
            >
              <Avatar
                name={isMine ? me.displayName : message.senderName}
                hue={isMine ? me.avatarHue : message.avatarHue}
                type={isMine ? 'user' : message.senderType}
                size="sm"
                url={isMine ? me.avatarUrl : message.avatarUrl}
              />
            </button>
          ) : (
            <Avatar
              name={isMine ? me.displayName : message.senderName}
              hue={isMine ? me.avatarHue : message.avatarHue}
              type={isMine ? 'user' : message.senderType}
              size="sm"
              url={isMine ? me.avatarUrl : message.avatarUrl}
            />
          )}

          <div className="msg__col">
            {!isMine ? (
              <div className="msg__head">
                {/* 名字行只留名字：AI 身份由头像右下角那个小字承担，
                    「由谁创建」在「我的 AI」里看，这里不再重复 */}
                <span className="msg__name">{message.senderName}</span>
              </div>
            ) : null}

            {quoted ? (
              <button
                type="button"
                className={cn('quote', isMine && 'quote--mine', !quoted.found && 'quote--missing')}
                onClick={() => {
                  if (message.replyToSeq != null) handlers.jumpTo(message.replyToSeq)
                }}
                title={quoted.found ? '点击跳到原消息' : '原消息不在已加载范围'}
              >
                <span className="quote__label">回复 @{quoted.name}：</span>
                <span className="quote__text">{quoted.text}</span>
              </button>
            ) : null}

            <div className="msg__bubble-row">
              <MessageContent
                parts={parts}
                stickerUrl={stickerUrl}
                onOpenImage={handlers.openImage}
                bubbleHandlers={bubbleHandlers}
              />
              {showStamp ? (
                <span className="msg__stamp" title={`发送于 ${separator ? `${separator} ` : ''}${clock}`}>
                  {clock}
                </span>
              ) : null}
            </div>

            <div className="msg__foot">
              {message.optimistic ? <span className="msg__pending">发送中…</span> : null}
              {message.failed ? (
                <button
                  type="button"
                  className="msg__retry"
                  onClick={() => {
                    if (message.clientMsgId) handlers.retry(message.clientMsgId)
                  }}
                >
                  发送失败，重试
                </button>
              ) : null}
              {interactive && !message.failed ? (
                <button type="button" className="msg__reply" onClick={() => handlers.reply(message)}>
                  回复
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function sameQuote(a: MessageRowProps['quoted'], b: MessageRowProps['quoted']): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  return a.found === b.found && a.name === b.name && a.text === b.text
}

/**
 * 比较器：默认浅比较会因为父组件每帧新建的 `quoted` 对象而永远失败，所以逐字段比。
 * handlers / suppressRef / stickerUrl / me 都是刻意做成身份稳定的，直接用 ===。
 */
export const MessageRow = memo(MessageRowBase, (prev, next) => {
  return (
    prev.message === next.message &&
    prev.me === next.me &&
    prev.separator === next.separator &&
    prev.clock === next.clock &&
    prev.showStamp === next.showStamp &&
    prev.highlighted === next.highlighted &&
    prev.canOpenProfile === next.canOpenProfile &&
    prev.stickerUrl === next.stickerUrl &&
    prev.handlers === next.handlers &&
    prev.suppressRef === next.suppressRef &&
    sameQuote(prev.quoted, next.quoted)
  )
})

export function MessageList({
  me,
  conversation,
  messages,
  loading,
  onRetry,
  onReply,
  onRecallMessage,
  onReportMessage,
  onOpenProfile,
  jumpSeq,
  onJumped,
  typingNames = [],
  onLoadOlder,
  notify,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null)
  // 「回看历史时来了新消息」的计数（外部评审前端 §4-3）：只在没贴底时累加，点一下回到底部
  const [unread, setUnread] = useState(0)
  const maxSeqRef = useRef(0)
  const loadingOlderRef = useRef(false)
  const noMoreOlderRef = useRef(false)
  // 首帧稳定标记：挂载时的「贴底滚动」也会触发 scroll 事件，那时 scrollTop 还接近 0，
  // 不拦住会被误判成「用户滚到顶了」→ 把「已到最早」永久置位（实测踩过）。
  const readyRef = useRef(false)
  // 第一次把会话的整窗消息填进 DOM 时要强制贴底：此时 scrollTop=0 且内容很长，
  // nearBottom() 一定是 false——如果只按「接近底部才贴底」，打开会话会停在历史顶部。
  const pendingStickRef = useRef(true)
  const highlightTimer = useRef<number | null>(null)
  // 灯箱：点开一张图看大图
  const [lightbox, setLightbox] = useState<ImagePart | null>(null)
  // 长按/右键动作面板
  const [menuFor, setMenuFor] = useState<LocalMessage | null>(null)
  const pressTimer = useRef<number | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  // 订阅表情包（加载完会让自定义包的表情地址刷新；没加载完用内置兜底）
  const { packs } = useStickerPacks()
  // 包列表变化 → 解析函数身份变化 → 消息行刷新一次（自定义包的表情地址是后来才有的）
  const packsRev = packs.length === 0 ? '' : packs.map((pack) => `${pack.id}:${pack.items.length}`).join('|')
  const stickerUrl = useMemo(
    () => (pack: string, key: string) => stickerSrc(pack, key),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [packsRev],
  )

  const stickToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    })
  }, [])

  // 切换会话 / 离开聊天页：停掉正在播的语音，别在后台一直响
  useEffect(() => {
    return () => {
      stopVoice()
    }
  }, [conversation?.id, stickToBottom])

  // 切会话关掉动作面板
  useEffect(() => {
    setMenuFor(null)
    clearPress()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, stickToBottom])

  useEffect(() => {
    return () => {
      clearPress()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }, [])

  // 会话切换：直接滚到底部（behavior:'auto' 覆盖 CSS 的 smooth，避免动画期间读到的位置是旧值）
  useEffect(() => {
    readyRef.current = false
    noMoreOlderRef.current = false
    pendingStickRef.current = true
    setUnread(0)
    stickToBottom()
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        readyRef.current = true
      })
    })
  }, [conversation?.id, stickToBottom])

  // 新增消息：仅在接近底部时自动贴底，避免打断向上翻历史的人
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pendingStickRef.current) {
      if (messages.length > 0) {
        pendingStickRef.current = false
        stickToBottom()
        setUnread(0)
      }
      return
    }
    if (nearBottom()) stickToBottom()
  }, [messages.length, nearBottom, stickToBottom])

  // 新消息 pill：用「最大 seq 是否变大」区分追加与向上补历史（补历史不该算未读）
  useEffect(() => {
    const maxSeq = messages.reduce((acc, item) => (item.seq != null && item.seq > acc ? item.seq : acc), 0)
    const prevMax = maxSeqRef.current
    maxSeqRef.current = maxSeq
    if (!readyRef.current || pendingStickRef.current) return
    if (maxSeq <= prevMax) return
    if (nearBottom()) {
      setUnread(0)
      return
    }
    const incoming = messages.filter((item) => item.seq != null && item.seq > prevMax).length
    if (incoming > 0) setUnread((n) => n + incoming)
  }, [messages, nearBottom])

  /** 滚到顶部附近触发翻历史；加载后按「高度差」把滚动位置补回去（锚点不跳） */
  function handleScroll() {
    clearPress()
    const el = scrollRef.current
    if (!el) return
    if (nearBottom()) setUnread(0)
    if (!readyRef.current) return
    if (!onLoadOlder || loadingOlderRef.current || noMoreOlderRef.current) return
    if (el.scrollTop > 120) return
    loadingOlderRef.current = true
    const beforeHeight = el.scrollHeight
    const beforeTop = el.scrollTop
    void onLoadOlder()
      .then((added) => {
        if (added === 0) noMoreOlderRef.current = true
        window.requestAnimationFrame(() => {
          const el2 = scrollRef.current
          if (el2) el2.scrollTop = beforeTop + (el2.scrollHeight - beforeHeight)
          loadingOlderRef.current = false
        })
      })
      .catch(() => {
        loadingOlderRef.current = false
      })
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setUnread(0)
  }

  useEffect(() => {
    return () => {
      if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current)
    }
  }, [])

  // 从成员主页跳过来：消息到达后滚到那条并高亮
  useEffect(() => {
    if (jumpSeq == null) return
    if (!messages.some((item) => item.seq === jumpSeq)) return
    jumpTo(jumpSeq)
    onJumped?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq, messages])

  function jumpTo(seq: number) {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`)
    if (!target) return false
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlightSeq(seq)
    if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current)
    highlightTimer.current = window.setTimeout(() => setHighlightSeq(null), 1400)
    return true
  }

  /* ---------------- 长按 / 右键动作面板 ---------------- */

  function clearPress() {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressOrigin.current = null
  }

  function openMenu(message: LocalMessage) {
    if (message.seq == null || message.recalledAt) return
    // 长按触发后，松手那一帧的 click 要吞掉，避免误触
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 700)
    try {
      navigator.vibrate?.(15)
    } catch {
      /* 不支持震动就算了 */
    }
    setMenuFor(message)
  }

  function startPress(message: LocalMessage, event: PressEvent) {
    if (message.seq == null || message.recalledAt) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    clearPress()
    pressOrigin.current = { x: event.clientX, y: event.clientY }
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      pressOrigin.current = null
      openMenu(message)
    }, LONG_PRESS_MS)
  }

  function movePress(event: PressEvent) {
    const origin = pressOrigin.current
    if (!origin) return
    if (Math.abs(event.clientX - origin.x) > LONG_PRESS_MOVE_PX || Math.abs(event.clientY - origin.y) > LONG_PRESS_MOVE_PX) {
      clearPress()
    }
  }

  /* ---------------- 行回调：稳定门面（memo 的前提） ---------------- */

  const rowImplRef = useRef<RowHandlers>({
    openProfile: () => {},
    openMenu: () => {},
    reply: () => {},
    retry: () => {},
    jumpTo: () => {},
    openImage: () => {},
    startPress: () => {},
    movePress: () => {},
    clearPress: () => {},
  })
  // 每次渲染刷新实现（拿最新 props / state），门面对象的身份不变
  rowImplRef.current = {
    openProfile: (principalId) => onOpenProfile?.(principalId),
    openMenu,
    reply: onReply,
    retry: onRetry,
    jumpTo,
    openImage: (part) => setLightbox(part),
    startPress,
    movePress,
    clearPress,
  }
  const rowHandlers = useMemo<RowHandlers>(
    () => ({
      openProfile: (principalId) => rowImplRef.current.openProfile(principalId),
      openMenu: (message) => rowImplRef.current.openMenu(message),
      reply: (message) => rowImplRef.current.reply(message),
      retry: (clientMsgId) => rowImplRef.current.retry(clientMsgId),
      jumpTo: (seq) => rowImplRef.current.jumpTo(seq),
      openImage: (part) => rowImplRef.current.openImage(part),
      startPress: (message, event) => rowImplRef.current.startPress(message, event),
      movePress: (event) => rowImplRef.current.movePress(event),
      clearPress: () => rowImplRef.current.clearPress(),
    }),
    [],
  )

  /**
   * 行数据一次扫完：日分隔、时间戳去重都是「顺序相关」的，只能在整表上算；
   * 引用预览也在这里按 seq 建索引（以前是每行 `messages.find` → O(n²)）。
   * 依赖只有 messages：动作面板/新消息 pill/灯箱这些状态变化不会重算这些字符串。
   */
  const rows = useMemo(() => {
    const replyTargets = new Set<number>()
    for (const item of messages) {
      if (item.replyToSeq != null) replyTargets.add(item.replyToSeq)
    }
    const quoteOfSeq = new Map<number, { name: string; text: string }>()
    if (replyTargets.size > 0) {
      for (const item of messages) {
        if (item.seq == null || !replyTargets.has(item.seq)) continue
        quoteOfSeq.set(item.seq, {
          name: item.senderName,
          // 引用里的原文预览：图片/表情消息显示 [图片]/[表情]，不再是一段空白
          text: quoteOf(previewOf(normalizeParts(item.parts, item.body), item.body), 20),
        })
      }
    }
    let lastDay = ''
    // QQ 手感：时间戳贴在气泡外侧，11px 灰字，同一分钟内不重复显示
    let lastStamp = ''
    return messages.map((message) => {
      const currentDay = dayKey(message.createdAt)
      let separator: string | null = null
      if (currentDay !== lastDay) {
        lastDay = currentDay
        separator = formatDayLabel(message.createdAt)
      }
      // 时间戳：同一分钟内只出现一次（跨天靠 dayKey 一起参与判重）；
      // 系统消息不占用这一分钟，免得它后面那条正常消息反而没有时间
      const clock = formatClock(message.createdAt)
      const stampKey = clock ? `${currentDay} ${clock}` : ''
      const showStamp = message.kind !== 'system' && stampKey !== '' && stampKey !== lastStamp
      if (showStamp) lastStamp = stampKey
      let quoted: { name: string; text: string; found: boolean } | null = null
      if (message.replyToSeq != null) {
        const hit = quoteOfSeq.get(message.replyToSeq)
        if (hit) quoted = { name: hit.name, text: hit.text, found: true }
        else if (message.replyPreview)
          quoted = { name: '原消息', text: quoteOf(message.replyPreview, 20), found: false }
        else quoted = { name: '原消息', text: `#${message.replyToSeq}`, found: false }
      }
      return { message, separator, clock, showStamp, quoted }
    })
  }, [messages])

  if (!conversation) {
    return (
      <div className="messages messages--empty">
        <div className="empty-state">
          <p className="empty-state__title">选一个会话开始聊天</p>
          <p className="empty-state__hint">左侧列表里点一个群；没有群就点右上角的 ＋</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="messages" ref={scrollRef} onScroll={handleScroll}>
        <div className="messages__inner">
          {loading && messages.length === 0 ? (
            <p className="messages__loading" role="status" aria-live="polite">正在加载消息…</p>
          ) : null}
          {!loading && messages.length === 0 ? (
            // 空态不是加载态：单独 class + role=status，读屏才会把「这里还没有消息」念出来
            <p className="messages__empty" role="status" aria-live="polite">这里还没有消息，说点什么吧。</p>
          ) : null}

          {rows.map((row, index) => (
            <div key={row.message.seq != null ? `s-${row.message.seq}` : `c-${row.message.clientMsgId ?? index}`}>
              <MessageRow
                message={row.message}
                me={me}
                separator={row.separator}
                clock={row.clock}
                showStamp={row.showStamp}
                quoted={row.quoted}
                highlighted={highlightSeq != null && row.message.seq === highlightSeq}
                canOpenProfile={onOpenProfile != null}
                stickerUrl={stickerUrl}
                suppressRef={suppressClickRef}
                handlers={rowHandlers}
              />
            </div>
          ))}
        </div>
      </div>

      {/* 「N 条新消息」：回看历史时追加的消息，点一下回到底部（QQ/微信标配） */}
      {unread > 0 ? (
        <button type="button" className="new-msg-pill" onClick={jumpToBottom}>
          {unread > 99 ? '99+' : unread} 条新消息 ↓
        </button>
      ) : null}

      {/* 「XX 正在输入…」：放在消息滚动区之外、输入栏之上——放进滚动区会因为内容不足贴在顶部，
          或者被滚走；这里始终固定在输入栏上方，且不会挡住最后一条消息的点击 */}
      {typingNames.length > 0 ? (
        <div className="typing" role="status" aria-live="polite">
          <span className="typing__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {typingNames.length === 1
            ? `${typingNames[0]} 正在输入…`
            : typingNames.length === 2
              ? `${typingNames[0]}、${typingNames[1]} 正在输入…`
              : `${typingNames[0]} 等 ${typingNames.length} 人正在输入…`}
        </div>
      ) : null}

      {lightbox && lightbox.url ? (
        <Lightbox url={lightbox.url} alt="图片" onClose={() => setLightbox(null)} />
      ) : null}

      {menuFor ? (
        <MessageActionSheet
          message={menuFor}
          mine={menuFor.senderId === me.id}
          notify={notify}
          onClose={() => setMenuFor(null)}
          onQuote={() => onReply(menuFor)}
          onRecall={() => onRecallMessage(menuFor)}
          onReport={(reason) => onReportMessage(menuFor, reason)}
        />
      ) : null}
    </>
  )
}
