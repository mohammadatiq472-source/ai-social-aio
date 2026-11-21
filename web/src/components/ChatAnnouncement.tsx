import { useEffect, useRef, useState } from 'react'
import { cn, formatRelative } from '../utils'

interface ChatAnnouncementProps {
  /** 纯文本公告；空/纯空白 = 不渲染整条 */
  announcement?: string
  updatedAt?: string | null
}

/**
 * 聊天页顶部的群公告条（只读）。
 *
 * 约束：
 * - 纯文本 + white-space: pre-wrap，绝不进 markdown/HTML 渲染（公告是群主写的，不是消息内容段）。
 * - 默认折叠到 3 行；只有真被截断时才出现「展开」，避免小公告挂一个没用的按钮。
 * - 编辑入口只在群设置（GroupSettingsDialog），这里所有成员都只读。
 * - 放在 .messages 外面、正常文档流里：消息区是 flex:1 + overflow-y:auto，
 *   多这一块只会让 clientHeight 变小，贴底/翻历史逻辑不用改（和 AiSafetyNote 同理）。
 */
export function ChatAnnouncement({ announcement, updatedAt }: ChatAnnouncementProps) {
  const text = (announcement ?? '').trim()
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const textRef = useRef<HTMLParagraphElement | null>(null)

  // 切群/公告被改后先收起：否则会继承上一条公告的展开状态
  useEffect(() => {
    setExpanded(false)
  }, [text])

  // clamp 的 overflow 判定：scrollHeight > clientHeight 说明被截了
  useEffect(() => {
    if (!text || expanded) return
    const check = () => {
      const el = textRef.current
      if (!el) return
      setCanExpand(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [text, expanded])

  if (!text) return null

  return (
    <section className="chat-announcement" aria-label="群公告">
      <div className="chat-announcement__head">
        <span className="chat-announcement__label">群公告</span>
        {updatedAt ? <span className="chat-announcement__meta">{formatRelative(updatedAt)}更新</span> : null}
        {canExpand || expanded ? (
          <button
            type="button"
            className="chat-announcement__toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
      <p
        ref={textRef}
        className={cn(
          'chat-announcement__text',
          expanded ? 'chat-announcement__text--expanded' : 'chat-announcement__text--clamp',
        )}
        data-testid="chat-announcement-text"
      >
        {text}
      </p>
    </section>
  )
}
