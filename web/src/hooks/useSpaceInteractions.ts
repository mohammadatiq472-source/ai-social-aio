// 说说卡片的互动状态：点赞、评论区展开 / 加载 / 发表。
// 从 SpaceView 抽出来（2026-11-16 第二轮大组件拆分）。放 hooks/ 而不是 components/space/：
// 它没有任何 JSX、只操作「按 feed.id 索引的状态表」+ setFeeds，和 useChatStream/useComposer 同一层；
// components/space/ 下都是纯展示组件，把带网络时序的状态塞进去会让那层不再纯。
//
// 为什么不把这些状态搬进 FeedCard：点赞/评论的乐观更新必须改**列表里的那条**（feeds 在 SpaceView），
// 卡片只拿到一个 feed 对象；状态表留在上层，卡片才能只靠 props 渲染。
//
// 硬约束（沿用原实现，DOM/文案/ARIA 一字未改）：
// - id < 0 表示还没上服务端的乐观项，点赞/评论全部拒绝；
// - 点赞乐观 +1、失败回滚到 before，成功以服务端 res.liked 为准（服务端幂等去重）；
// - 评论失败**不丢草稿**：只有在用户没重新输入时才把原文放回去，避免覆盖新输入。
import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { api, ApiError, feedReasonText } from '../api'
import { makeClientMsgId } from '../utils'
import type { ToastKind } from '../components/Toast'
import { COMMENT_MAX } from '../components/space/limits'
import type { CommentState, LocalFeed } from '../components/space/types'

interface Options {
  /** 列表本体仍由 SpaceView 持有：这里只改单条的 likedByMe/likeCount/commentCount */
  setFeeds: Dispatch<SetStateAction<LocalFeed[]>>
  notify: (text: string, kind?: ToastKind) => void
}

export function useSpaceInteractions({ setFeeds, notify }: Options) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [commentBusy, setCommentBusy] = useState<Record<number, boolean>>({})
  const [likeBusy, setLikeBusy] = useState<Record<number, boolean>>({})
  const [openIds, setOpenIds] = useState<Record<number, boolean>>({})
  const [comments, setComments] = useState<Record<number, CommentState>>({})

  const setDraft = useCallback((feedId: number, value: string) => {
    setDrafts((prev) => ({ ...prev, [feedId]: value }))
  }, [])

  /* ---------------- 点赞（乐观 +1，失败回滚） ---------------- */

  async function toggleLike(feed: LocalFeed) {
    if (feed.id < 0 || likeBusy[feed.id]) return
    const before = { likedByMe: feed.likedByMe, likeCount: feed.likeCount }
    const next = !feed.likedByMe

    setFeeds((prev) =>
      prev.map((item) =>
        item.id === feed.id
          ? { ...item, likedByMe: next, likeCount: Math.max(0, item.likeCount + (next ? 1 : -1)) }
          : item,
      ),
    )
    setLikeBusy((prev) => ({ ...prev, [feed.id]: true }))

    try {
      const res = next ? await api.likeFeed(feed.id) : await api.unlikeFeed(feed.id)
      // 以服务端返回的 liked 为准（重复点赞时服务端会幂等去重）
      const liked = typeof res.liked === 'boolean' ? res.liked : next
      setFeeds((prev) =>
        prev.map((item) =>
          item.id === feed.id
            ? { ...item, likedByMe: liked, likeCount: Math.max(0, before.likeCount + (liked ? 1 : -1)) }
            : item,
        ),
      )
    } catch (err) {
      setFeeds((prev) => prev.map((item) => (item.id === feed.id ? { ...item, ...before } : item)))
      notify(err instanceof ApiError ? err.message : '点赞失败，请重试', 'error')
    } finally {
      setLikeBusy((prev) => {
        const nextMap = { ...prev }
        delete nextMap[feed.id]
        return nextMap
      })
    }
  }

  /* ---------------- 评论 ---------------- */

  const loadComments = useCallback(async (feedId: number) => {
    setComments((prev) => ({
      ...prev,
      [feedId]: { loading: true, error: '', items: prev[feedId]?.items ?? [] },
    }))
    try {
      const list = await api.feedComments(feedId)
      setComments((prev) => ({ ...prev, [feedId]: { loading: false, error: '', items: list } }))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      setComments((prev) => ({
        ...prev,
        [feedId]: {
          loading: false,
          error: err instanceof ApiError ? err.message : '评论加载失败',
          items: prev[feedId]?.items ?? [],
        },
      }))
    }
  }, [])

  function toggleComments(feed: LocalFeed) {
    if (feed.id < 0) return
    const opening = !openIds[feed.id]
    setOpenIds((prev) => ({ ...prev, [feed.id]: opening }))
    if (opening && comments[feed.id] == null) void loadComments(feed.id)
  }

  async function submitComment(feed: LocalFeed) {
    if (feed.id < 0 || commentBusy[feed.id]) return
    const text = (drafts[feed.id] ?? '').trim()
    if (text.length === 0) return
    if (text.length > COMMENT_MAX) {
      notify(`评论最多 ${COMMENT_MAX} 字`, 'error')
      return
    }

    const clientMsgId = makeClientMsgId()
    setDrafts((prev) => ({ ...prev, [feed.id]: '' }))
    setCommentBusy((prev) => ({ ...prev, [feed.id]: true }))
    try {
      const res = await api.commentFeed(feed.id, { body: text, clientMsgId })
      if (!res.accepted) {
        setDrafts((prev) => (prev[feed.id]?.trim() ? prev : { ...prev, [feed.id]: text }))
        notify(res.message || feedReasonText(res.reason), 'error')
        return
      }
      setOpenIds((prev) => ({ ...prev, [feed.id]: true }))
      setFeeds((prev) =>
        prev.map((item) => (item.id === feed.id ? { ...item, commentCount: item.commentCount + 1 } : item)),
      )
      // 重新拉一次，以服务端返回的评论列表（含他人/AI 的回复）为准
      void loadComments(feed.id)
    } catch (err) {
      setDrafts((prev) => (prev[feed.id]?.trim() ? prev : { ...prev, [feed.id]: text }))
      notify(err instanceof ApiError ? err.message : '评论失败，请重试', 'error')
    } finally {
      setCommentBusy((prev) => {
        const nextMap = { ...prev }
        delete nextMap[feed.id]
        return nextMap
      })
    }
  }

  return {
    drafts,
    commentBusy,
    likeBusy,
    openIds,
    comments,
    setDraft,
    toggleLike,
    toggleComments,
    submitComment,
    loadComments,
  }
}
