import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, feedReasonText } from '../api'
import type { FeedVisibility, Me } from '../types'
import { makeClientMsgId } from '../utils'
import { useSpaceInteractions } from '../hooks/useSpaceInteractions'
import type { ToastKind } from './Toast'
import { FeedComposer } from './space/FeedComposer'
import { FeedList } from './space/FeedList'
import { FeedModeration } from './space/FeedModeration'
import { FEED_MAX } from './space/limits'
import type { LocalFeed } from './space/types'

interface SpaceViewProps {
  me: Me
  notify: (text: string, kind?: ToastKind) => void
}

const PAGE_SIZE = 20

/**
 * 我的空间 / 说说流：只保留数据加载、翻页、乐观更新与事件编排。
 *
 * 为什么拆（2026-11-15 大组件拆分）：原文件 647 行，近一半是重复 N 次的卡片/评论区 JSX，
 * 和「加载 / 翻页 / 幂等重试」缠在一起。现在展示全在 space/ 下：
 * FeedComposer（输入区）、FeedList（列表与各状态）、FeedCard（单条）、
 * FeedComments（评论区）、FeedMoreSheet + FeedModeration（⋯ 菜单与举报）。
 * 点赞/评论的状态与网络时序在 hooks/useSpaceInteractions（2026-11-16 第二轮）。
 * 硬约束：DOM、class 名、文案、ARIA 一律沿用原实现，本轮只搬代码。
 */
export function SpaceView({ me, notify }: SpaceViewProps) {
  const [feeds, setFeeds] = useState<LocalFeed[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // 说说翻页（外部评审前端 §4-5）：服务端按 id 倒序，before_id 传当前列表里最小的正数 id
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [body, setBody] = useState('')
  const [visibility, setVisibility] = useState<FeedVisibility>('friends')
  const [posting, setPosting] = useState(false)
  // 说说右上角「⋯」当前选中的条目；菜单与举报面板由 FeedModeration 托管
  const [menuFeed, setMenuFeed] = useState<LocalFeed | null>(null)
  // 点赞 / 评论：状态表与网络时序都在 hook 里，只对 setFeeds 做单条改写
  const { drafts, commentBusy, likeBusy, openIds, comments, setDraft, toggleLike, toggleComments, submitComment, loadComments } =
    useSpaceInteractions({ setFeeds, notify })

  // 只为了「刚刚 / N 分钟前」能随时间自己走字，每 60 秒重渲染一次
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 60000)
    return () => window.clearInterval(timer)
  }, [])

  /* ---------------- 说说流 ---------------- */

  const loadFeeds = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const list = await api.feeds(0, PAGE_SIZE)
      // 保留仍在发布中的本地项，其余以服务端为准（服务端按 id 倒序）
      setFeeds((prev) => [...prev.filter((item) => item.pending), ...list])
      // 满一页就认为还有更早的（下一页用最后一条的 id 当 before_id）
      setHasMore(list.length >= PAGE_SIZE)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      setLoadError(err instanceof ApiError ? err.message : '说说加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFeeds()
  }, [loadFeeds])

  /** 加载更早的说说：按「当前最小 id」往前翻，去重后追加到列表尾部 */
  const loadMoreFeeds = useCallback(async () => {
    if (loadingMore) return
    const oldest = feeds.reduce((acc, item) => (item.id > 0 && (acc === 0 || item.id < acc) ? item.id : acc), 0)
    if (!oldest) {
      setHasMore(false)
      return
    }
    setLoadingMore(true)
    try {
      const list = await api.feeds(oldest, PAGE_SIZE)
      setFeeds((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        return [...prev, ...list.filter((item) => !seen.has(item.id))]
      })
      setHasMore(list.length >= PAGE_SIZE)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      notify(err instanceof ApiError ? err.message : '加载更多失败，请重试', 'error')
    } finally {
      setLoadingMore(false)
    }
  }, [feeds, loadingMore, notify])

  async function publish() {
    const text = body.trim()
    if (posting) return
    if (text.length === 0) {
      notify('写点什么再发布吧', 'error')
      return
    }
    if (text.length > FEED_MAX) {
      notify(`说说最多 ${FEED_MAX} 字`, 'error')
      return
    }

    // 每次新发用新的 client_msg_id；失败重试（同一 clientMsgId）服务端会幂等去重
    const clientMsgId = makeClientMsgId()
    const tempId = -Date.now()
    const optimistic: LocalFeed = {
      id: tempId,
      authorId: me.id,
      authorType: 'user',
      authorName: me.displayName,
      avatarHue: me.avatarHue,
      body: text,
      visibility,
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
      createdAt: new Date().toISOString(),
      pending: true,
      clientMsgId,
    }

    setFeeds((prev) => [optimistic, ...prev])
    setBody('')
    setPosting(true)

    const restoreDraft = () => {
      // 用户已经重新输入时不要覆盖
      setBody((prev) => (prev.trim().length > 0 ? prev : text))
    }

    try {
      const res = await api.publishFeed({ body: text, visibility, clientMsgId })
      if (!res.accepted) {
        setFeeds((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId))
        restoreDraft()
        notify(res.message || feedReasonText(res.reason), 'error')
        return
      }
      if (typeof res.feed_id !== 'number') {
        // 没拿到 feed_id：宁可重拉，也不留一条没有服务端 id 的卡片
        setFeeds((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId))
        await loadFeeds()
        notify('已发布', 'success')
        return
      }
      const feedId = res.feed_id
      setFeeds((prev) =>
        prev.map((item) => (item.clientMsgId === clientMsgId ? { ...item, id: feedId, pending: false } : item)),
      )
      notify('已发布', 'success')
    } catch (err) {
      // 4xx 是「确定不要这条」（内容不合法等）：撤回乐观项并还原草稿
      // 传输入错 / 5xx 是「不知道服务端收没收到」：保留卡片，重试复用同一个 client_msg_id，服务端幂等
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500
      if (definitive) {
        setFeeds((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId))
        restoreDraft()
        notify(err instanceof ApiError ? err.message : '发布失败，请重试', 'error')
      } else {
        setFeeds((prev) =>
          prev.map((item) =>
            item.clientMsgId === clientMsgId ? { ...item, pending: false, failed: true } : item,
          ),
        )
        notify('发布失败，可能是网络问题；点卡片上的「重试」再发一次，不会重复', 'error')
      }
    } finally {
      setPosting(false)
    }
  }

  /** 重试发布：必须复用原来的 client_msg_id（服务端按 (actor_id, client_msg_id) 幂等） */
  async function retryPublish(feed: LocalFeed) {
    const clientMsgId = feed.clientMsgId
    if (!clientMsgId || posting) return
    setPosting(true)
    setFeeds((prev) =>
      prev.map((item) => (item.clientMsgId === clientMsgId ? { ...item, pending: true, failed: false } : item)),
    )
    try {
      const res = await api.publishFeed({ body: feed.body, visibility: feed.visibility, clientMsgId })
      if (!res.accepted) {
        setFeeds((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId))
        notify(res.message || feedReasonText(res.reason), 'error')
        return
      }
      if (typeof res.feed_id !== 'number') {
        setFeeds((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId))
        await loadFeeds()
        notify('已发布', 'success')
        return
      }
      const feedId = res.feed_id
      setFeeds((prev) =>
        prev.map((item) =>
          item.clientMsgId === clientMsgId ? { ...item, id: feedId, pending: false, failed: false } : item,
        ),
      )
      notify('已发布', 'success')
    } catch (err) {
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500
      if (definitive) {
        setFeeds((prev) => prev.filter((item) => item.clientMsgId !== clientMsgId))
        notify(err instanceof ApiError ? err.message : '重试失败，请稍后再试', 'error')
      } else {
        setFeeds((prev) =>
          prev.map((item) =>
            item.clientMsgId === clientMsgId ? { ...item, pending: false, failed: true } : item,
          ),
        )
        notify(err instanceof ApiError ? err.message : '重试失败，请稍后再试', 'error')
      }
    } finally {
      setPosting(false)
    }
  }

  const closeMenu = useCallback(() => setMenuFeed(null), [])

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="space">
      <div className="space__inner">
        <header className="space__head">
          <h1 className="space__title">我的空间</h1>
        </header>

        <FeedComposer
          body={body}
          visibility={visibility}
          posting={posting}
          onBodyChange={setBody}
          onVisibilityChange={setVisibility}
          onPublish={() => void publish()}
        />

        <FeedList
          feeds={feeds}
          loading={loading}
          loadError={loadError}
          hasMore={hasMore}
          loadingMore={loadingMore}
          openIds={openIds}
          drafts={drafts}
          comments={comments}
          commentBusy={commentBusy}
          likeBusy={likeBusy}
          posting={posting}
          onReload={loadFeeds}
          onLoadMore={loadMoreFeeds}
          onOpenMenu={setMenuFeed}
          onToggleLike={toggleLike}
          onToggleComments={toggleComments}
          onRetryPublish={retryPublish}
          onDraftChange={setDraft}
          onSubmitComment={submitComment}
          onReloadComments={loadComments}
        />
      </div>

      <FeedModeration menuFeed={menuFeed} onCloseMenu={closeMenu} notify={notify} />
    </div>
  )
}
