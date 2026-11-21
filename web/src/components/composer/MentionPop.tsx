// @ 补全浮层：候选成员列表 + 键盘高亮。
// 为什么拆：这块有 listbox/aria-selected 的语义细节，和补全逻辑（谁在候选、按哪个下标）
// 分开放——补全逻辑留在 Composer，这里只负责把候选画出来并回报鼠标动作。
import type { Member } from '../../types'
import { cn } from '../../utils'
import { Avatar } from '../Avatar'

interface ComposerMentionPopProps {
  query: string
  matches: Member[]
  activeIndex: number
  onActivate: (index: number) => void
  onPick: (member: Member) => void
}

export function ComposerMentionPop({ query, matches, activeIndex, onActivate, onPick }: ComposerMentionPopProps) {
  return (
    <div className="mention-pop" role="listbox" aria-label="选择要 @ 的成员">
      <div className="mention-pop__head">
        @ 成员 <span className="mention-pop__hint">{query ? `匹配「${query}」` : '全部'}</span>
      </div>
      {matches.length === 0 ? (
        <p className="mention-pop__empty">没有匹配的成员</p>
      ) : (
        matches.map((member, index) => (
          <button
            key={member.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={cn('mention-item', index === activeIndex && 'mention-item--active')}
            onMouseEnter={() => onActivate(index)}
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(member)
            }}
          >
            <Avatar name={member.displayName} hue={member.avatarHue} url={member.avatarUrl} type={member.type} size="sm" />
            <span className="mention-item__name">{member.displayName}</span>
            <span className={cn('mention-item__kind', member.type === 'agent' ? 'is-agent' : 'is-user')}>
              {member.type === 'agent' ? 'AI' : '人'}
            </span>
          </button>
        ))
      )}
    </div>
  )
}
