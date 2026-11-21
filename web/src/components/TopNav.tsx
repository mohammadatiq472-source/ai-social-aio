import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Me } from '../types'
import { cn } from '../utils'
import { Avatar } from './Avatar'

/** 一级视图：聊天 / 空间 / 好友 / 我的；站务多一个「审核」（只有 is_admin 看得到） */
export type AppView = 'chat' | 'space' | 'friends' | 'me' | 'admin'

interface TabDef {
  key: AppView
  label: string
  /** 手机上标签短一些，一行放得下 */
  short: string
  icon: ReactNode
}

/* 图标一律用 currentColor 的线性 SVG：不依赖任何品牌资产，选中态直接换主色 */
const ChatIcon = (
  <svg className="tabbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path
      d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H11l-4 3.2V16H6.5A2.5 2.5 0 0 1 4 13.5v-7Z"
      strokeLinejoin="round"
    />
  </svg>
)

const SpaceIcon = (
  <svg className="tabbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="6.4" />
    <ellipse cx="12" cy="12" rx="10.2" ry="3.8" transform="rotate(-24 12 12)" />
  </svg>
)

const MeIcon = (
  <svg className="tabbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="8.2" r="3.6" />
    <path d="M4.8 20c0-3.6 3.2-5.8 7.2-5.8s7.2 2.2 7.2 5.8" strokeLinecap="round" />
  </svg>
)

const FriendsIcon = (
  <svg className="tabbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="9" cy="8.4" r="3.2" />
    <path d="M3.4 19c0-2.9 2.5-4.6 5.6-4.6s5.6 1.7 5.6 4.6" strokeLinecap="round" />
    <path d="M15.6 5.6a3.1 3.1 0 0 1 0 6M17.2 14.9c2 .5 3.4 2 3.4 4.1" strokeLinecap="round" />
  </svg>
)

const ShieldIcon = (
  <svg className="tabbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 3.6 19 6v6.2c0 4-3 7-7 8.2-4-1.2-7-4.2-7-8.2V6l7-2.4Z" strokeLinejoin="round" />
    <path d="m9.2 12.2 2 2 3.6-3.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const TABS: TabDef[] = [
  { key: 'chat', label: '聊天', short: '聊天', icon: ChatIcon },
  { key: 'space', label: '空间', short: '空间', icon: SpaceIcon },
  { key: 'friends', label: '好友', short: '好友', icon: FriendsIcon },
  { key: 'me', label: '我的', short: '我的', icon: MeIcon },
  { key: 'admin', label: '审核', short: '审核', icon: ShieldIcon },
]

/** 站务标签只对管理员可见（服务端每个接口还会再校验一次，前端隐藏只是别让人误点） */
function tabsFor(isAdmin: boolean): TabDef[] {
  return isAdmin ? TABS : TABS.filter((tab) => tab.key !== 'admin')
}

interface TopNavProps {
  me: Me
  view: AppView
  onChange: (view: AppView) => void
  isAdmin?: boolean
}

/**
 * 桌面左侧导航栏（≥1024px 显示；手机/平板由 CSS 隐藏）。
 *
 * 为什么单独一个组件而不是给 TopNav 加个「竖着」的样式：两者的信息层级不同——
 * 顶栏是「品牌 + 页签 + 当前用户」，竖栏是「入口图标 + 底部头像」，DOM 结构就不一样。
 * 图标沿用同一份 TABS，避免两处各自维护一套入口。
 */
export function SideRail({ me, view, onChange, isAdmin = false }: TopNavProps) {
  // 未读数：复用 ChatView 已经发出的 aio:unread 事件，而不是把 conversations 提到 App 层。
  // 为什么不在 App 里存：ChatView 卸载（切到空间/我的）时数据层也跟着卸载，
  // 但事件是"最后一次已知值"，切页面时红点不该凭空归零——和文档标题的处理口径一致。
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    const onUnread = (event: Event) => {
      const total = Number((event as CustomEvent<{ total?: number }>).detail?.total)
      setUnread(Number.isFinite(total) && total > 0 ? total : 0)
    }
    window.addEventListener('aio:unread', onUnread)
    return () => window.removeEventListener('aio:unread', onUnread)
  }, [])

  return (
    <nav className="rail" aria-label="主导航">
      <span className="rail__brand">AIO</span>
      {tabsFor(isAdmin).map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={cn('rail__btn', view === tab.key && 'rail__btn--active')}
          aria-label={tab.key === 'chat' && unread > 0 ? `${tab.label}（${unread} 条未读）` : tab.label}
          aria-current={view === tab.key ? 'page' : undefined}
          title={tab.label}
          onClick={() => onChange(tab.key)}
        >
          {tab.icon}
          {tab.key === 'chat' && unread > 0 ? (
            <span className="rail__badge" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      ))}
      <span className="rail__spacer" />
      <button
        type="button"
        className="rail__me"
        aria-label={`${me.displayName}（我的）`}
        title={me.displayName}
        onClick={() => onChange('me')}
      >
        <Avatar name={me.displayName} hue={me.avatarHue} url={me.avatarUrl} size="sm" />
      </button>
    </nav>
  )
}

/** 桌面顶部导航：复用登录页的 .tabs / .tab 胶囊样式与 .avatar（契约 §10 视觉语言） */
export function TopNav({ me, view, onChange, isAdmin = false }: TopNavProps) {
  return (
    <header className="topnav">
      <span className="topnav__brand">AIO</span>
      <div className="tabs topnav__tabs" role="tablist" aria-label="主导航">
        {tabsFor(isAdmin).map((tab) => {
          const active = tab.key === view
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={cn('tab', active && 'tab--active')}
              onClick={() => onChange(tab.key)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="topnav__me" title={me.displayName}>
        <Avatar name={me.displayName} hue={me.avatarHue} url={me.avatarUrl} size="sm" />
        <span className="topnav__me-name">{me.displayName}</span>
      </div>
    </header>
  )
}

interface BottomTabBarProps {
  view: AppView
  onChange: (view: AppView) => void
  /** 进入某个会话时隐藏：底部让给输入栏（QQ 的手感） */
  hidden?: boolean
  isAdmin?: boolean
}

/** 手机底部 Tab：44px 触控高度、选中态主色、安全区内边距（≤760px 才显示，桌面隐藏） */
export function BottomTabBar({ view, onChange, hidden, isAdmin = false }: BottomTabBarProps) {
  return (
    <nav className={cn('tabbar', hidden && 'tabbar--hidden')} aria-label="主导航（底部）">
      {tabsFor(isAdmin).map((tab) => {
        const active = tab.key === view
        return (
          <button
            key={tab.key}
            type="button"
            className={cn('tabbar__btn', active && 'tabbar__btn--active')}
            aria-current={active ? 'page' : undefined}
            onClick={() => onChange(tab.key)}
          >
            {tab.icon}
            <span>{tab.short}</span>
          </button>
        )
      })}
    </nav>
  )
}
