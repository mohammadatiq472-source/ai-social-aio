import { FeedCard } from './FeedCard'
import { FeedComments } from './FeedComments'
import type { CommentState, LocalFeed } from './types'

interface FeedListProps {
  feeds: LocalFeed[]
  loading: boolean
  loadError: string
  hasMore: boolean
  loadingMore: boolean
  /** 按 feed.id 存的界面状态：折叠开关 / 草稿 / 评论态 / 各按钮 busy */
  openIds: Record<number, boolean>
  drafts: Record<number, string>
  comments: Record<number, CommentState>
  commentBusy: Record<number, boolean>
  likeBusy: Record<number, boolean>
  posting: boolean
  onReload: () => void
  onLoadMore: () => void
  onOpenMenu: (feed: LocalFeed) => void
  onToggleLike: (feed: LocalFeed) => void
  onToggleComments: (feed: LocalFeed) => void
  onRetryPublish: (feed: LocalFeed) => void
  onDraftChange: (feedId: number, value: string) => void
  onSubmitComment: (feed: LocalFeed) => void
  onReloadComments: (feedId: number) => void
}

/**
 * 说说列表：加载中 / 加载失败 / 空态 / 卡片列表 / 「加载更早」按钮。
 *
 * 为什么拆：这五段之前直接写在主视图的 return 里，占了 50 多行且全是展示分支；
 * 主视图改成只往下传状态与回调，翻页数据仍由主视图持有（这里不自己 fetch）。
 * 各状态块的判断顺序、DOM 与 class 名与原实现逐字一致。
 */
export function FeedList({
  feeds,
  loading,
  loadError,
  hasMore,
  loadingMore,
  openIds,
  drafts,
  comments,
  commentBusy,
  likeBusy,
  posting,
  onReload,
  onLoadMore,
  onOpenMenu,
  onToggleLike,
  onToggleComments,
  onRetryPublish,
  onDraftChange,
  onSubmitComment,
  onReloadComments,
}: FeedListProps) {
  return (
    <>
      {loading ? <p className="space__loading">正在加载说说…</p> : null}

      {!loading && loadError ? (
        <div className="space__state" role="alert">
          <p className="space__state-title">说说加载失败</p>
          <p className="space__state-hint">{loadError}</p>
          <button type="button" className="btn" onClick={() => onReload()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !loadError && feeds.length === 0 ? (
        <div className="empty-state space__empty">
          <p className="empty-state__title">还没有说说</p>
          <p className="empty-state__hint">在上面写第一句，好友就能看到了。</p>
        </div>
      ) : null}

      {feeds.map((feed) => {
        const commentsOpen = openIds[feed.id] === true
        return (
          <FeedCard
            key={feed.id}
            feed={feed}
            commentsOpen={commentsOpen}
            likeBusy={likeBusy[feed.id] === true}
            posting={posting}
            onOpenMenu={onOpenMenu}
            onToggleLike={onToggleLike}
            onToggleComments={onToggleComments}
            onRetryPublish={onRetryPublish}
          >
            {commentsOpen ? (
              <FeedComments
                authorName={feed.authorName}
                state={comments[feed.id]}
                draft={drafts[feed.id] ?? ''}
                busy={commentBusy[feed.id] === true}
                onDraftChange={(value) => onDraftChange(feed.id, value)}
                onSubmit={() => onSubmitComment(feed)}
                onReload={() => onReloadComments(feed.id)}
              />
            ) : null}
          </FeedCard>
        )
      })}

      {/* 翻页：还有更早的说说时显示；本地 pending 项 id 为负不影响游标 */}
      {hasMore ? (
        <button type="button" className="space__more" onClick={() => onLoadMore()} disabled={loadingMore}>
          {loadingMore ? '加载中…' : '加载更早的说说'}
        </button>
      ) : null}
    </>
  )
}
