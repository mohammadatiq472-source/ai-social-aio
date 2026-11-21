import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject, TouchEvent as ReactTouchEvent } from 'react'
import type { Conversation, Member } from '../types'
import { cn, formatRelative, REPLY_MODE_TEXT, ROLE_TEXT } from '../utils'
import { Avatar } from './Avatar'

interface MemberPanelProps {
  conversation: Conversation | null
  /** 关闭成员面板（移动端抽屉用） */
  onClose?: () => void
  /** 大群成员还在拉取：先显示「正在加载成员…」 */
  loading?: boolean
  /** 拉取失败后重试 */
  onRetryMembers?: () => void
  /** 点头像/名字看成员主页 */
  onOpenProfile?: (principalId: number) => void
  ownerNameOf: (principalId: number) => string | null
  /** 当前登录用户昵称：用来判断「由你创建」 */
  meName: string
  /** 是否显示「退出群聊」：非群主 + 群聊才显示（服务端仍会再校验） */
  canLeave?: boolean
  onLeave?: () => void
}

/** 手机上是底部抽屉：按住抽屉头部 / 抓手向下拖即可关闭 */
function isPhoneSheet(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
}

interface VirtualListProps {
  members: Member[]
  /** 首屏先用估算高度，量到真实行高后自动校正 */
  estimatedRowHeight: number
  scrollRef: RefObject<HTMLDivElement | null>
  renderRow: (member: Member) => React.ReactNode
}

/**
 * 定高行虚拟列表：300 人大群只挂可视区 + overscan 的十几行 DOM。
 * 行高不用猜——先按估算值渲染一屏，再用第一行真实高度校正（同组行高一致）。
 */
function VirtualList({ members, estimatedRowHeight, scrollRef, renderRow }: VirtualListProps) {
  const listRef = useRef<HTMLUListElement | null>(null)
  const [rowH, setRowH] = useState(estimatedRowHeight)
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(members.length, 16) }))
  const overscan = 6

  const recompute = useCallback(() => {
    const scroll = scrollRef.current
    const list = listRef.current
    if (!scroll || !list) return
    const scrollRect = scroll.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    // 列表相对滚动容器内容顶部的偏移
    const listTop = listRect.top - scrollRect.top + scroll.scrollTop
    const viewport = scroll.clientHeight || 480
    const first = Math.floor((scroll.scrollTop - listTop) / rowH)
    const start = Math.max(0, Math.min(members.length, first - overscan))
    const visible = Math.ceil(viewport / rowH) + overscan * 2
    const end = Math.max(start, Math.min(members.length, start + visible))
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [members.length, rowH, scrollRef])

  // 行数 / 行高变化后重算窗口
  useLayoutEffect(() => {
    recompute()
  }, [recompute])

  // 量真实行高（虚拟行外层是定高槽位，行本身仍是自然高度）
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector('.member-row') as HTMLElement | null
    if (!row) return
    const measured = Math.round(row.getBoundingClientRect().height) + 2 // + 列表行间距
    if (measured > 24 && Math.abs(measured - rowH) > 1) setRowH(measured)
  }, [members.length, rowH])

  // 滚动：rAF 节流；容器尺寸变化（抽屉展开 / 旋屏）也重算
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        recompute()
      })
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll)
    observer?.observe(scroll)
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [recompute, scrollRef])

  const slice = members.slice(range.start, range.end)

  return (
    <ul
      className="members__list members__list--virtual"
      ref={listRef}
      style={{ height: `${members.length * rowH}px` }}
    >
      {slice.map((member, offset) => {
        const index = range.start + offset
        return (
          <li
            key={member.id}
            className="member-row-slot"
            style={{ top: `${index * rowH}px`, height: `${rowH}px` }}
          >
            {renderRow(member)}
          </li>
        )
      })}
    </ul>
  )
}

export function MemberPanel({
  conversation,
  onClose,
  loading,
  onRetryMembers,
  onOpenProfile,
  ownerNameOf,
  meName,
  canLeave = false,
  onLeave,
}: MemberPanelProps) {
  const members = conversation?.members ?? []
  const humans = useMemo(() => members.filter((member) => member.type === 'user'), [members])
  const agents = useMemo(() => members.filter((member) => member.type === 'agent'), [members])
  // 大群用后端给的总数；小群/已加载时就是 members.length
  const total = conversation?.memberCount ?? members.length
  const incomplete = conversation?.membersComplete === false

  const sheetRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startY: number; dy: number } | null>(null)

  // 切会话：列表回顶
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [conversation?.id])

  function startDrag(event: ReactTouchEvent<HTMLElement>) {
    if (!onClose || !isPhoneSheet()) return
    const touch = event.touches[0]
    if (!touch) return
    dragRef.current = { startY: touch.clientY, dy: 0 }
    if (sheetRef.current) sheetRef.current.style.transition = 'none'
  }

  function moveDrag(event: ReactTouchEvent<HTMLElement>) {
    const drag = dragRef.current
    const el = sheetRef.current
    if (!drag || !el) return
    const touch = event.touches[0]
    if (!touch) return
    const dy = Math.max(0, touch.clientY - drag.startY)
    drag.dy = dy
    el.style.transform = `translateY(${dy}px)`
  }

  function endDrag() {
    const drag = dragRef.current
    const el = sheetRef.current
    dragRef.current = null
    if (!drag || !el) return
    // 交还给 CSS：关闭时父组件摘掉 --open，过渡会把抽屉送回底部
    el.style.transition = ''
    el.style.transform = ''
    if (drag.dy > 88) onClose?.()
  }

  function renderHuman(member: Member) {
    return (
      <div className="member-row">
        <button
          type="button"
          className="member-row__avatar"
          onClick={() => onOpenProfile?.(member.id)}
          aria-label={`查看 ${member.displayName} 的主页`}
        >
          <Avatar name={member.displayName} hue={member.avatarHue} type="user" size="sm" url={member.avatarUrl} />
        </button>
        <div className="member-row__main">
          <span className="member-row__name">
            {member.displayName}
            {member.role !== 'member' ? (
              <span className={cn('role-pill', `role-pill--${member.role}`)}>{ROLE_TEXT[member.role]}</span>
            ) : null}
          </span>
          <span className="member-row__meta">
            {member.online ? <span className="online-dot" title="在线" /> : null}
            {member.online ? '在线' : '离线'}
          </span>
        </div>
      </div>
    )
  }

  function renderAgent(member: Member) {
    // ownerName 由后端在成员上直接返回；「你」是通讯录兜底返回的本人标记
    const owner = member.ownerName ?? ownerNameOf(member.id)
    const mine = owner === '你' || (owner != null && meName !== '' && owner === meName)
    const lastSync = member.lastSyncedAt ?? member.lastSyncAt ?? member.lastSeenAt ?? null
    // AI 没有 WS 连接：用「最近 5 分钟有没有 MCP 调用（agent_tokens.last_used_at）」近似在线，
    // 别把「MCP 轮询」当成人在线——但也不能让 AI 永远显示离线，用户会以为它坏了。
    const lastSyncMs = lastSync ? new Date(lastSync).getTime() : 0
    const agentOnline = lastSyncMs > 0 && Date.now() - lastSyncMs <= 5 * 60_000
    return (
      <div className="member-row member-row--agent">
        <button
          type="button"
          className="member-row__avatar"
          onClick={() => onOpenProfile?.(member.id)}
          aria-label={`查看 ${member.displayName} 的主页`}
        >
          <Avatar name={member.displayName} hue={member.avatarHue} type="agent" size="sm" url={member.avatarUrl} />
        </button>
        <div className="member-row__main">
          <span className="member-row__name">
            {member.displayName}
            <span className={cn('mode-pill', `mode-pill--${member.replyMode}`)}>
              {REPLY_MODE_TEXT[member.replyMode] ?? member.replyMode}
            </span>
            {member.agentStatus === 'paused' ? (
              <span className="agent-paused-pill" title="已暂停：它仍在群里，但不会发言">
                已暂停
              </span>
            ) : null}
          </span>
          <span className="member-row__meta">
            {agentOnline ? <span className="online-dot" title="最近 5 分钟有 MCP 调用" /> : null}
            上次同步：{lastSync ? formatRelative(lastSync) : '未知'}
          </span>
          {member.allowAiRelay ? <span className="member-row__meta">可接 AI 的话</span> : null}
          <span className="member-row__meta member-row__owner">{mine ? '由你创建' : `由 ${owner ?? '其他用户'} 创建`}</span>
          {mine ? <span className="member-row__adjust">在「我的 → 我的 AI」里调整</span> : null}
        </div>
      </div>
    )
  }

  return (
    <aside className="members" ref={sheetRef} aria-label="成员列表">
      <div
        className="members__grabber"
        aria-hidden="true"
        onTouchStart={startDrag}
        onTouchMove={moveDrag}
        onTouchEnd={endDrag}
        onTouchCancel={endDrag}
      />

      <header className="members__head" onTouchStart={startDrag} onTouchMove={moveDrag} onTouchEnd={endDrag}>
        <h2 className="members__title">成员 {total}</h2>
        {onClose ? (
          <button type="button" className="icon-btn members__close" onClick={onClose} aria-label="关闭成员列表">
            ✕
          </button>
        ) : null}
      </header>

      {conversation === null ? (
        <p className="members__empty">选择一个会话后查看成员</p>
      ) : loading && incomplete ? (
        <p className="members__empty members__loading" role="status">
          <span className="members__spinner" aria-hidden="true" />
          正在加载成员…
        </p>
      ) : (
        <div className="members__scroll" ref={scrollRef}>
          {incomplete ? (
            <p className="members__tip">
              还有 {Math.max(0, total - members.length)} 位成员未加载
              {onRetryMembers ? (
                <button type="button" className="link-btn" onClick={onRetryMembers}>
                  重试
                </button>
              ) : null}
            </p>
          ) : null}

          <section className="members__section">
            <h3 className="members__subtitle">成员 · 人 {humans.length}</h3>
            {humans.length === 0 ? (
              <p className="members__empty-line">暂无真人成员</p>
            ) : (
              <VirtualList
                members={humans}
                estimatedRowHeight={48}
                scrollRef={scrollRef}
                renderRow={renderHuman}
              />
            )}
          </section>

          <section className="members__section">
            <h3 className="members__subtitle">成员 · AI {agents.length}</h3>
            {agents.length === 0 ? (
              <p className="members__empty-line">这个群还没有 AI 成员</p>
            ) : (
              <VirtualList
                members={agents}
                estimatedRowHeight={92}
                scrollRef={scrollRef}
                renderRow={renderAgent}
              />
            )}
          </section>

          {/* 退群：只对「非群主的群聊」显示。群主不能退（否则群变无主），私聊也不能退。
              放在成员列表末尾而不是头部：退群是「离开这些人」的动作，位置本身在表达语义。 */}
          {canLeave && onLeave ? (
            <section className="members__section">
              <button type="button" className="btn btn--danger members__leave" onClick={onLeave}>
                退出群聊
              </button>
            </section>
          ) : null}
        </div>
      )}
    </aside>
  )
}
