import type { ReactNode } from 'react'
import { cn, formatFeedTime } from '../../utils'
import { Avatar } from '../Avatar'
import type { LocalFeed } from './types'

interface FeedCardProps {
  feed: LocalFeed
  commentsOpen: boolean
  likeBusy: boolean
  posting: boolean
  onOpenMenu: (feed: LocalFeed) => void
  onToggleLike: (feed: LocalFeed) => void
  onToggleComments: (feed: LocalFeed) => void
  onRetryPublish: (feed: LocalFeed) => void
  /**
   * 评论区整块（由 FeedComments 渲染）。
   * 用 children 传进来而不是让卡片内部去拉数据：评论区在 <article> 内部，
   * 但它的加载/草稿状态属于主视图，卡片保持纯展示。
   */
  children?: ReactNode
}

/**
 * 单条说说卡片：作者行 / 正文 / 失败重试行 / 点赞评论数 / 更多菜单入口。
 *
 * 为什么拆：这是列表里重复 N 次的那块纯展示；拆出去后主视图只剩数据与事件。
 * DOM 与 class 名逐字保留（含 <article>/<header> 层级），视觉不做任何改动。
 */
export function FeedCard({
  feed,
  commentsOpen,
  likeBusy,
  posting,
  onOpenMenu,
  onToggleLike,
  onToggleComments,
  onRetryPublish,
  children,
}: FeedCardProps) {
  const isAI = feed.authorType === 'agent'
  return (
    <article
      className={cn(
        'feed',
        isAI && 'feed--ai',
        feed.pending && 'feed--pending',
        feed.failed && 'feed--failed',
      )}
    >
      <header className="feed__head">
        <Avatar name={feed.authorName} hue={feed.avatarHue} url={feed.avatarUrl} type={feed.authorType} size="md" />
        <div className="feed__meta">
          <div className="feed__name-row">
            <span className="feed__name">{feed.authorName}</span>
            {isAI ? (
              <span className="ai-badge" title="这是 AI 成员">
                AI
              </span>
            ) : null}
            {feed.visibility === 'private' ? <span className="feed__private">仅自己</span> : null}
          </div>
          <span className="feed__time">
            {feed.pending ? '发布中…' : feed.failed ? '发布失败' : formatFeedTime(feed.createdAt)}
          </span>
        </div>
        {feed.id > 0 && !feed.pending ? (
          <button
            type="button"
            className="icon-btn feed__more"
            aria-label="更多操作"
            title="更多操作"
            onClick={() => onOpenMenu(feed)}
          >
            ⋯
          </button>
        ) : null}
      </header>

      <p className="feed__body">{feed.body}</p>

      {feed.failed ? (
        <p className="feed__failed">
          这条还没发出去
          <button type="button" className="link-btn" disabled={posting} onClick={() => onRetryPublish(feed)}>
            重试
          </button>
        </p>
      ) : null}

      <div className="feed__actions">
        <button
          type="button"
          className={cn('feed__action', feed.likedByMe && 'feed__action--liked')}
          aria-pressed={feed.likedByMe}
          aria-label={feed.likedByMe ? '取消点赞' : '点赞'}
          disabled={feed.id < 0 || likeBusy}
          onClick={() => onToggleLike(feed)}
        >
          <span aria-hidden="true">{feed.likedByMe ? '♥' : '♡'}</span>
          点赞 {feed.likeCount}
        </button>
        <button
          type="button"
          className={cn('feed__action', commentsOpen && 'feed__action--open')}
          aria-expanded={commentsOpen}
          disabled={feed.id < 0}
          onClick={() => onToggleComments(feed)}
        >
          <span aria-hidden="true">💬</span>
          评论 {feed.commentCount}
        </button>
      </div>

      {children}
    </article>
  )
}
