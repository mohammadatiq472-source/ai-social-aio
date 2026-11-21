import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import { Modal } from './Modal'

interface GroupItem {
  id: number
  title: string
  description: string
  memberCount: number
  joined: boolean
  joinMode: 'open' | 'approval'
}

interface DiscoverGroupsDialogProps {
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
  onClose: () => void
  /** 加入/申请后刷新会话列表；open 模式直接进群时可以顺手打开 */
  onJoined?: (conversationId: number, joined: boolean) => void
}

/**
 * 发现群聊：公开推荐的群，**行列表**（不是卡片），复用现有 Modal。
 * 入口在会话列表表头的 🧭，不改顶栏 tab、不改三栏布局。
 */
export function DiscoverGroupsDialog({ notify, onClose, onJoined }: DiscoverGroupsDialogProps) {
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<GroupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [busy, setBusy] = useState(0)
  const requestId = useRef(0)

  const load = useCallback(
    async (q: string, before: number, append: boolean) => {
      const rid = ++requestId.current
      setLoading(true)
      try {
        const res = await api.discoverGroups(q, before, 20)
        if (rid !== requestId.current) return
        const list = Array.isArray(res?.groups) ? res.groups : []
        setGroups((prev) => (append ? [...prev, ...list] : list))
        setHasMore(Boolean(res?.hasMore))
        setNextBefore(res?.nextBeforeId ?? null)
      } catch (err) {
        if (rid !== requestId.current) return
        notify(err instanceof ApiError ? err.message : '发现群聊加载失败', 'error')
      } finally {
        if (rid === requestId.current) setLoading(false)
      }
    },
    [notify],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query, 0, false), 260)
    return () => window.clearTimeout(timer)
  }, [query, load])

  async function join(group: GroupItem) {
    if (busy) return
    setBusy(group.id)
    try {
      const res = await api.joinGroup(group.id)
      if (res?.pending) {
        notify('已提交申请，等群主同意', 'success')
        setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, joined: true } : g)))
      } else {
        notify('已加入群聊', 'success')
        setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, joined: true } : g)))
        onJoined?.(group.id, true)
        onClose()
      }
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '加入失败，请稍后重试', 'error')
    } finally {
      setBusy(0)
    }
  }

  return (
    <Modal title="发现群聊" onClose={onClose} wide>
      <div className="gd">
        <input
          className="input gd__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索群名（公开推荐的群才会出现在这里）"
          maxLength={40}
        />
        {loading && groups.length === 0 ? <p className="card__hint">正在加载…</p> : null}
        {!loading && groups.length === 0 ? (
          <p className="card__hint">没有找到公开推荐的群。群主可以在「群设置 → 公开推荐」里把自己的群放出来。</p>
        ) : null}
        <ul className="gd__list">
          {groups.map((group) => (
            <li key={group.id} className="gd__row">
              <div className="gd__main">
                <span className="gd__title">{group.title || '未命名群'}</span>
                {group.description ? <span className="gd__desc">{group.description}</span> : null}
                <span className="gd__meta">
                  {group.memberCount} 人 · {group.joinMode === 'open' ? '自由加入' : '需群主审批'}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={group.joined || busy === group.id}
                onClick={() => void join(group)}
              >
                {group.joined ? '已加入' : busy === group.id ? '处理中…' : group.joinMode === 'open' ? '加入' : '申请'}
              </button>
            </li>
          ))}
        </ul>
        {hasMore ? (
          <div className="gd__more">
            <button
              type="button"
              className="btn btn--sm"
              disabled={loading}
              onClick={() => void load(query, nextBefore ?? 0, true)}
            >
              {loading ? '加载中…' : '加载更多'}
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
