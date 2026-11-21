import type { FeedVisibility } from '../../types'
import { FEED_MAX } from './limits'

interface FeedComposerProps {
  body: string
  visibility: FeedVisibility
  posting: boolean
  onBodyChange: (value: string) => void
  onVisibilityChange: (value: FeedVisibility) => void
  onPublish: () => void
}

const VISIBILITY_OPTIONS: Array<{ value: FeedVisibility; label: string }> = [
  { value: 'friends', label: '好友可见' },
  { value: 'private', label: '仅自己' },
]

/**
 * 发布说说输入区（文案 / 可见范围 / 字数 / 发布按钮）。
 *
 * 为什么拆：这块只关心「受控输入 + 提交意图」，跟列表分页、乐观更新无关；
 * 空文案/超长等校验和 publish() 请求仍留在 SpaceView，这里只把动作回抛。
 * 注意 Ctrl/⌘+Enter 走 onPublish，普通 Enter 保留换行（原行为）。
 */
export function FeedComposer({
  body,
  visibility,
  posting,
  onBodyChange,
  onVisibilityChange,
  onPublish,
}: FeedComposerProps) {
  return (
    <section className="feed-composer" aria-label="发布说说">
      <textarea
        className="feed-composer__input"
        value={body}
        rows={3}
        maxLength={FEED_MAX}
        placeholder="此刻在想什么…"
        aria-label="说说正文"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl / ⌘ + Enter 快捷发布；普通 Enter 保留换行
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            onPublish()
          }
        }}
      />
      <div className="feed-composer__foot">
        <select
          className="feed-composer__vis"
          value={visibility}
          aria-label="可见范围"
          onChange={(event) => onVisibilityChange(event.target.value === 'private' ? 'private' : 'friends')}
        >
          {VISIBILITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="feed-composer__counter">
          {body.length} / {FEED_MAX}
        </span>
        <button
          type="button"
          className="btn btn--primary feed-composer__submit"
          disabled={posting || body.trim().length === 0}
          onClick={onPublish}
        >
          {posting ? '发布中…' : '发布'}
        </button>
      </div>
    </section>
  )
}
