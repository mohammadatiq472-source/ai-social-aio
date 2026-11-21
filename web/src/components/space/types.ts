import type { Feed, FeedComment } from '../../types'

/**
 * 本地说说：pending = 乐观插入（id 为负数临时值），failed = 可重试的发布失败，
 * clientMsgId 用于成功后校正 / 重试复用。
 *
 * 为什么放共享类型：卡片按 pending/failed 换样式与「重试」按钮，主视图按同一字段做乐观更新，
 * 拆成子组件后两边必须看同一份形状，避免各写一份容易漂移。
 */
export interface LocalFeed extends Feed {
  pending?: boolean
  failed?: boolean
  clientMsgId?: string
}

/** 单条说说的评论区状态（按 feed.id 存，折叠再展开不重拉） */
export interface CommentState {
  loading: boolean
  error: string
  items: FeedComment[]
}
