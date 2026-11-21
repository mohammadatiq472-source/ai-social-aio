import { Avatar } from '../Avatar'
import { formatFeedTime } from '../../utils'
import { COMMENT_MAX } from './limits'
import type { CommentState } from './types'

interface FeedCommentsProps {
  /** 被评论说说的作者名，用于输入框 placeholder（原行为） */
  authorName: string
  /** undefined = 还没拉过；loading 且 items 为空时显示加载提示 */
  state: CommentState | undefined
  draft: string
  busy: boolean
  onDraftChange: (value: string) => void
  onSubmit: () => void
  /** 加载失败后点「重试」 */
  onReload: () => void
}

/**
 * 评论区（列表 + 写评论表单）。
 *
 * 为什么拆：它有自己的加载中/失败/空态三种分支和一行输入框，是卡片里唯一的「重内容」；
 * 但数据仍由主视图持有（按 feed.id 缓存，折叠再展开不重拉），这里只做纯渲染 + 回调。
 * 单独成块是因为如果塞进 FeedCard，卡片会从「纯展示」变成「有状态」，不利于后续复用/测试。
 */
export function FeedComments({
  authorName,
  state,
  draft,
  busy,
  onDraftChange,
  onSubmit,
  onReload,
}: FeedCommentsProps) {
  function renderList() {
    if (state == null || (state.loading && state.items.length === 0)) {
      return <p className="feed-comments__hint">正在加载评论…</p>
    }
    if (state.error && state.items.length === 0) {
      return (
        <p className="feed-comments__hint">
          {state.error}
          <button type="button" className="link-btn" onClick={onReload}>
            重试
          </button>
        </p>
      )
    }
    if (state.items.length === 0) {
      return <p className="feed-comments__hint">还没有评论，来说一句。</p>
    }
    return state.items.map((comment) => (
      <div key={comment.id} className="feed-comment">
        <Avatar
          name={comment.authorName}
          hue={comment.avatarHue}
          url={comment.avatarUrl}
          type={comment.authorType}
          size="sm"
        />
        <div className="feed-comment__main">
          <div className="feed-comment__head">
            <span className="feed-comment__name">{comment.authorName}</span>
            {comment.authorType === 'agent' ? <span className="ai-badge">AI</span> : null}
            <span className="feed-comment__time">{formatFeedTime(comment.createdAt)}</span>
          </div>
          <p className="feed-comment__body">{comment.body}</p>
        </div>
      </div>
    ))
  }

  return (
    <section className="feed__comments" aria-label="评论区">
      {renderList()}
      <form
        className="feed-comments__form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <input
          className="feed-comments__input"
          value={draft}
          maxLength={COMMENT_MAX}
          placeholder={`评论 ${authorName}…`}
          aria-label="写评论"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送；输入法组合中（选词回车）不拦截
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
        <button type="submit" className="btn btn--sm feed-comments__send" disabled={busy || draft.trim().length === 0}>
          {busy ? '发送中…' : '发送'}
        </button>
      </form>
    </section>
  )
}
