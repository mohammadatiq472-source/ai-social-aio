import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Conversation, Me, SearchHit, WsStatus } from '../types'
import { api, ApiError } from '../api'
import { cn, formatListTime, previewText } from '../utils'
import { Avatar } from './Avatar'
import { isMuted, toggleMuted, play } from '../sound'

interface ConversationListProps {
  me: Me
  conversations: Conversation[]
  activeId: number | null
  wsStatus: WsStatus
  onSelect: (id: number) => void
  onCreateGroup: () => void
  onDiscoverGroups: () => void
  onLogout: () => void
  /** 点了搜索结果：切到该会话并跳到那条消息（ChatView 负责补拉历史窗口） */
  onSearchPick: (conversationId: number, seq: number) => void
  /** 列表底部「加载更多会话」（几千个群时不要一次渲染完） */
  onLoadMoreConversations?: () => void
  hasMoreConversations?: boolean
  /** 会话列表加载失败（null = 正常）。失败和「真的没有群」要分开显示。 */
  loadError?: string | null
  onRetryLoad?: () => void
}

/** 关键词高亮：大小写不敏感，纯函数（不用 dangerouslySetInnerHTML，正文里可能有 <script>） */
function highlight(text: string, keyword: string): ReactNode {
  const kw = keyword.trim()
  if (!kw) return text
  const lower = text.toLowerCase()
  const needle = kw.toLowerCase()
  const out: ReactNode[] = []
  let from = 0
  let at = lower.indexOf(needle)
  let key = 0
  while (at >= 0) {
    if (at > from) out.push(text.slice(from, at))
    out.push(<mark key={key++}>{text.slice(at, at + kw.length)}</mark>)
    from = at + kw.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) out.push(text.slice(from))
  return out.length ? out : text
}

/** 输入停顿多久才打搜索接口（移动端输入法与网络都省一点） */
const SEARCH_DEBOUNCE_MS = 260

export function ConversationList({
  me,
  conversations,
  activeId,
  wsStatus,
  onSelect,
  onCreateGroup,
  onDiscoverGroups,
  onLogout,
  onSearchPick,
  onLoadMoreConversations,
  hasMoreConversations,
  loadError,
  onRetryLoad,
}: ConversationListProps) {
  // 静音开关：状态在 sound 模块里持久化到 localStorage
  const [muted, setMuted] = useState(() => isMuted())
  // ＋ 菜单：不额外加图标，避免会话表头再多一个视觉重心
  const [plusOpen, setPlusOpen] = useState(false)
  const plusRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!plusOpen) return
    const onDocClick = (event: MouseEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) setPlusOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [plusOpen])
  useEffect(() => { setMuted(isMuted()) }, [])
  const onToggleMute = useCallback(() => {
    const next = toggleMuted()
    setMuted(next)
    if (!next) play('recv')   // 开声音时给一声，确认真的响了
  }, [])

  /* ---------------- 消息搜索 ---------------- */

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 只认最后一次请求的结果：快速改关键词时，旧响应不能覆盖新结果
  const requestIdRef = useRef(0)

  const keyword = query.trim()

  useEffect(() => {
    if (!keyword) {
      requestIdRef.current += 1
      setHits([])
      setHasMore(false)
      setCursor(null)
      setSearchError(null)
      setSearching(false)
      return
    }
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setSearching(true)
    const timer = window.setTimeout(() => {
      api
        .searchMessages({ q: keyword, limit: 20 })
        .then((res) => {
          if (requestIdRef.current !== requestId) return
          setHits(res.results)
          setHasMore(res.hasMore)
          setCursor(res.nextBeforeEventId)
          setSearchError(null)
        })
        .catch((err) => {
          if (requestIdRef.current !== requestId) return
          if (err instanceof ApiError && err.code === 'unauthorized') return
          setHits([])
          setHasMore(false)
          setCursor(null)
          setSearchError(err instanceof ApiError ? err.message : '搜索失败，请重试')
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [keyword])

  // Esc 清空；Ctrl/⌘+K 聚焦搜索框（桌面快捷键，移动端无副作用）
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && document.activeElement === inputRef.current) {
        setQuery('')
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const loadMore = useCallback(async () => {
    if (cursor == null || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await api.searchMessages({ q: keyword, beforeEventId: cursor, limit: 20 })
      setHits((prev) => {
        const seen = new Set(prev.map((hit) => hit.eventId))
        return [...prev, ...res.results.filter((hit) => !seen.has(hit.eventId))]
      })
      setHasMore(res.hasMore)
      setCursor(res.nextBeforeEventId)
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'unauthorized')) {
        setSearchError(err instanceof ApiError ? err.message : '加载更多失败')
      }
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, keyword, loadingMore])

  const hitCount = hits.length

  return (
    <aside className="conv">
      <header className="conv__head">
        <div className="conv__me">
          <Avatar name={me.displayName} hue={me.avatarHue} size="sm" url={me.avatarUrl} />
          <div className="conv__me-text">
            <span className="conv__me-name">{me.displayName}</span>
            <span className={cn('conn', wsStatus === 'online' ? 'conn--on' : 'conn--off')}>
              {wsStatus === 'online' ? '已连接' : wsStatus === 'connecting' ? '连接中…' : '重连中…'}
            </span>
          </div>
        </div>
        <div className="conv__actions">
          <div className="conv__plus-wrap" ref={plusRef}>
            <button
              type="button"
              className="icon-btn"
              title="新建或发现群聊"
              aria-label="新建或发现群聊"
              aria-expanded={plusOpen}
              onClick={() => setPlusOpen((open) => !open)}
            >
              ＋
            </button>
            {plusOpen ? (
              <div className="conv__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="conv__menu-item"
                  onClick={() => {
                    setPlusOpen(false)
                    onCreateGroup()
                  }}
                >
                  新建群聊
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="conv__menu-item"
                  onClick={() => {
                    setPlusOpen(false)
                    onDiscoverGroups()
                  }}
                >
                  发现群聊
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={cn('icon-btn', muted && 'icon-btn--off')}
            title={muted ? '音效已静音（点击开启）' : '音效开启（点击静音）'}
            aria-label={muted ? '开启音效' : '静音'}
            aria-pressed={muted}
            onClick={onToggleMute}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button type="button" className="icon-btn" title="退出登录" aria-label="退出登录" onClick={onLogout}>
            ⏻
          </button>
        </div>
      </header>

      <div className="conv__search">
        <span className="conv__search-icon" aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          type="search"
          className="conv__search-input"
          placeholder="搜索消息（⌘/Ctrl+K）"
          aria-label="搜索消息"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
        />
        {query ? (
          <button
            type="button"
            className="conv__search-clear"
            aria-label="清空搜索"
            title="清空"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        ) : null}
      </div>

      {keyword ? (
        <div className="sr" role="region" aria-label="搜索结果">
          <div className="sr__status">
            {searching
              ? '正在搜索…'
              : searchError
                ? searchError
                : hitCount === 0
                  ? '没有找到匹配的消息'
                  : `找到 ${hitCount}${hasMore ? '+' : ''} 条 · 只搜你所在的群`}
          </div>

          <ul className="sr__list">
            {hits.map((hit) => (
              <li key={`${hit.conversationId}-${hit.seq}`}>
                <button
                  type="button"
                  className="sr__item"
                  onClick={() => onSearchPick(hit.conversationId, hit.seq)}
                >
                  <div className="sr__row">
                    <span className="sr__conv">{hit.conversationTitle}</span>
                    <span className="sr__time">{formatListTime(hit.createdAt)}</span>
                  </div>
                  <div className="sr__row">
                    <span className="sr__sender">
                      {hit.senderName}
                      {hit.senderType === 'agent' ? <span className="sr__ai">AI</span> : null}
                    </span>
                  </div>
                  <p className="sr__body">{highlight(hit.body, keyword)}</p>
                </button>
              </li>
            ))}
          </ul>

          {hasMore ? (
            <button type="button" className="sr__more" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="conv__title">
            <span>会话</span>
            <span className="conv__count">{conversations.length}</span>
          </div>

          {loadError && conversations.length > 0 ? (
            <div className="conv__error-bar" role="status">
              <span>刷新失败，显示的是上次的列表</span>
              {onRetryLoad ? (
                <button type="button" className="link-btn" onClick={onRetryLoad}>
                  重试
                </button>
              ) : null}
            </div>
          ) : null}

          <ul className="conv__list">
            {/* 加载失败 ≠ 没有群：失败必须给出原因 + 重试，否则用户以为自己的群都没了 */}
            {loadError && conversations.length === 0 ? (
              <li className="conv__error" role="alert">
                <span className="conv__error-text">会话加载失败：{loadError}</span>
                {onRetryLoad ? (
                  <button type="button" className="btn btn--sm" onClick={onRetryLoad}>
                    重试
                  </button>
                ) : null}
              </li>
            ) : null}
            {!loadError && conversations.length === 0 ? (
              <li className="conv__empty">
                还没有会话
                <button type="button" className="link-btn" onClick={onCreateGroup}>
                  新建一个群
                </button>
              </li>
            ) : null}

            {conversations.map((conv) => {
              // 大群 members 只含前 20 个 AI，用后端给的 agentCount；小群没有该字段时按成员数
              const agentCount = conv.agentCount ?? conv.members.filter((member) => member.type === 'agent').length
              // c2c 的 title 在库里是占位「未命名群」：显示对端昵称才有意义
              const peer = conv.type === 'c2c'
                ? conv.members.find((member) => member.id !== me.id)
                : null
              const name = conv.type === 'c2c'
                ? (peer?.displayName || conv.title || '单聊')
                : (conv.title || '未命名群')
              const hue = (conv.id * 47) % 360
              const preview = conv.lastMessagePreview ? previewText(conv.lastMessagePreview, 34) : '还没有消息'
              return (
                <li key={conv.id}>
                  <button
                    type="button"
                    className={cn('conv__item', conv.id === activeId && 'conv__item--active')}
                    onClick={() => onSelect(conv.id)}
                  >
                    <Avatar name={name} hue={hue} size="md" />
                    <div className="conv__body">
                      <div className="conv__row">
                        <span className="conv__name">{name}</span>
                        <span className="conv__time">{formatListTime(conv.lastMessageAt)}</span>
                      </div>
                      <div className="conv__row">
                        <span className="conv__preview">{preview}</span>
                        {agentCount > 0 ? (
                          <span className="conv__ai" title={`本会话有 ${agentCount} 个 AI 成员`}>
                            AI {agentCount}
                          </span>
                        ) : null}
                        {conv.unread > 0 ? (
                          <span className="badge-dot" aria-label={`${conv.unread} 条未读`}>
                            {conv.unread > 99 ? '99+' : conv.unread}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
            {hasMoreConversations ? (
              <li className="conv__more">
                <button type="button" className="btn btn--sm" onClick={() => onLoadMoreConversations?.()}>
                  加载更多会话
                </button>
              </li>
            ) : null}
          </ul>
        </>
      )}
    </aside>
  )
}
