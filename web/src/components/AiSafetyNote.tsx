import type { ReactNode } from 'react'
import { cn } from '../utils'

interface AiSafetyNoteProps {
  /** 传了就在右侧显示一个 ×（每次打开会话都会重新出现，不是永久关闭） */
  onClose?: () => void
  /**
   * friend = 好友列表里名字下方的一小块（按内容宽度贴左，不能把好友行拉变形）
   * chat   = 会话顶部通栏（贴在头栏下方，占满整行）
   */
  variant?: 'friend' | 'chat'
  children: ReactNode
}

/**
 * AI 身份提示条（黄色小字）。模仿微信「该用户是 AI」的做法：
 * 不弹窗、不加锁，只在名字/会话顶部一直挂一条提示，把「这段内容可能是模型生成的」摆在眼前。
 *
 * 改之前先看三条约束：
 * 1. 颜色只许走 var(--warn-weak-*)：`node scripts/check-style-tokens.mjs` 会拦字面色值，
 *    深浅色分别由 01-tokens.css 与 18-dark.css 的 :root 提供，这里不要单独打深色补丁。
 * 2. 必须留在正常文档流里。ChatView 的贴底/回到底部按 .messages 自己的
 *    scrollHeight / clientHeight 计算，position:absolute 的浮层会盖住消息，
 *    还会让 nearBottom() 读到「假的可见高度」——表现就是进群不贴底或翻历史失灵。
 * 3. 文案由调用方传入：好友页说的是「这是 AI 好友」，会话页说的是「对方是 AI 成员」，
 *    两句话不是同一件事，做成同一个组件只是为了视觉一致，不是为了共享文案。
 */
export function AiSafetyNote({ variant = 'friend', onClose, children }: AiSafetyNoteProps) {
  // 用 <span> 而不是 <p>：好友页里它要嵌在 .friend-row__main（本身就是 <span>）里，
  // <p> 套进 <span> 是非法嵌套；而 <span> 属于 phrasing content，放在 <div>（会话页）里也合法。
  // 两种形态的差别全部由 CSS 的 display 决定（friend = inline-flex / chat = flex）。
  return (
    <span className={cn('ai-note', variant === 'chat' && 'ai-note--chat')} role="note">
      <span className="ai-note__text">{children}</span>
      {onClose ? (
        <button type="button" className="ai-note__close" aria-label="关闭这条提示" onClick={onClose}>
          ×
        </button>
      ) : null}
    </span>
  )
}
