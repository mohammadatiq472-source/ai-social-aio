import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import type { Me } from './types'
import { AuthPage } from './components/AuthPage'
import { ChatView } from './components/ChatView'
import { ToastStack, useToasts } from './components/Toast'
import { BottomTabBar, SideRail, TopNav } from './components/TopNav'
import type { AppView } from './components/TopNav'
import { attachUnlockOnFirstGesture } from './sound'
import { clearAuthedSession, markAuthedSession, startStartupPrefetch } from './hooks/useChatStream'

// 路由级懒加载：聊天首屏只加载 ChatView，空间/好友/我的用到时才拉
const SpaceView = lazy(() => import('./components/SpaceView').then((m) => ({ default: m.SpaceView })))
const FriendsView = lazy(() => import('./components/FriendsView').then((m) => ({ default: m.FriendsView })))
const MeView = lazy(() => import('./components/MeView').then((m) => ({ default: m.MeView })))
const AdminView = lazy(() => import('./components/AdminView').then((m) => ({ default: m.AdminView })))

function ViewFallback() {
  return <div className="view-fallback" role="status" aria-live="polite">加载中…</div>
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [booting, setBooting] = useState(true)
  // 启动失败（网络/超时）：给「重试 / 去登录」，不要停在启动页转圈（前端审查 P1-2）
  const [bootError, setBootError] = useState<string | null>(null)
  const [view, setView] = useState<AppView>('chat')
  // 手机端是否正停在某个会话里：停在会话里时底部 Tab 让位给输入栏
  const [chatFocused, setChatFocused] = useState(false)
  const { items, push } = useToasts()
  // 供 401 监听器判断「是否本来就没登录」，避免首次访问弹「登录已过期」
  const meRef = useRef<Me | null>(null)
  meRef.current = me

  // 音效：浏览器 autoplay 策略要求首次交互后解锁，挂一次即可
  useEffect(() => attachUnlockOnFirstGesture(), [])

  // 启动：确认登录态。失败要分两类——401 是「没登录」→ 登录页；其余是「连不上」→ 重试屏。
  const bootstrap = useCallback(async () => {
    setBooting(true)
    setBootError(null)
    // 会话列表与 /api/me 并行：cookie 已经在，列表不依赖 me 的返回值（me 只用来确认登录态/拿资料）。
    // 以前是 me → 挂载 ChatView → 再拉列表，白等一个完整 RTT。这里先发，ChatView 挂载后消费同一个
    // promise（takeStartupPrefetch 只取一次，不会重复请求）。未登录时不会白跑：本地留过登录标记才预取。
    startStartupPrefetch()
    try {
      const profile = await api.me()
      markAuthedSession()
      setMe(profile)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') {
        // 标记已过期（换设备/清 cookie）：连同「上次会话」一起清掉，下次别再做无用的预取
        clearAuthedSession()
        setMe(null)
      } else {
        setBootError(err instanceof ApiError ? err.message : '网络连接失败')
      }
    } finally {
      setBooting(false)
    }
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // 未读数进标签页标题（ChatView 通过 aio:unread 事件上报；切到空间/我的也保留数字）
  useEffect(() => {
    const onUnread = (event: Event) => {
      const total = Number((event as CustomEvent<{ total?: number }>).detail?.total ?? 0)
      if (!Number.isFinite(total) || total <= 0) {
        document.title = 'AIO'
        return
      }
      document.title = `(${total > 99 ? '99+' : total}) AIO`
    }
    window.addEventListener('aio:unread', onUnread)
    return () => window.removeEventListener('aio:unread', onUnread)
  }, [])

  // 任意接口 401 时统一退回登录页
  useEffect(() => {
    const onUnauthorized = () => {
      if (meRef.current == null) return
      clearAuthedSession()
      setMe(null)
      setView('chat')
      setChatFocused(false)
      push('登录已过期，请重新登录', 'error')
    }
    window.addEventListener('qq:unauthorized', onUnauthorized)
    return () => window.removeEventListener('qq:unauthorized', onUnauthorized)
  }, [push])

  // 手机键盘弹起时把外壳压到「可视视口」高度，输入栏不会被键盘盖住
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const sync = () => {
      // 「桌面」= 鼠标设备 + 宽视口。粗指针（手机/平板）不看 innerWidth：iPhone 横屏 844px 会
      // 落进 >760 分支被当成桌面而跳过键盘适配，键盘一弹就把输入栏盖住（前端评审 M1）。
      // vv.height < 200 只是兜底：极端分屏/地址栏展开时写进去反而会把外壳压扁。
      const coarsePointer = window.matchMedia('(pointer: coarse)').matches
      const desktop = !coarsePointer && window.innerWidth > 760
      if (desktop || vv.height < 200) {
        root.style.removeProperty('--app-height')
        return
      }
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
    }
    sync()
    vv.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    return () => {
      vv.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      root.style.removeProperty('--app-height')
    }
  }, [])

  const changeView = useCallback((next: AppView) => {
    setView(next)
    // 离开聊天页时恢复底部 Tab（手机端聊天内是输入栏，不需要 Tab）
    if (next !== 'chat') setChatFocused(false)
  }, [])

  async function handleLogout() {
    try {
      await api.logout()
    } catch {
      // 退出失败也把本地状态清掉，避免卡住
    }
    clearAuthedSession()
    setMe(null)
    setView('chat')
    setChatFocused(false)
    document.title = 'AIO'
    push('已退出登录', 'info')
  }

  if (booting) {
    return (
      <div className="splash">
        <div className="splash__logo">AIO</div>
        <p className="splash__hint">正在确认登录状态…</p>
      </div>
    )
  }

  // 启动失败：不要伪装成「未登录」，也不要无限转圈
  if (bootError) {
    return (
      <div className="splash">
        <div className="splash__logo">AIO</div>
        <p className="splash__hint" role="alert">连接失败：{bootError}</p>
        <div className="crash__actions">
          <button type="button" className="btn btn--primary" onClick={() => void bootstrap()}>
            重试
          </button>
          <button type="button" className="btn" onClick={() => setBootError(null)}>
            去登录
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {me == null ? (
        <AuthPage
          notify={push}
          onAuthed={(profile) => {
            // 登录成功也要留标记：否则「今天第一次登录 → 明天再打开」的那次启动仍然是串行
            markAuthedSession()
            setMe(profile)
            setView('chat')
            setChatFocused(false)
          }}
        />
      ) : (
        <div className="shell">
          {/* 桌面 ≥1024px 用左侧 rail；平板仍用顶栏；两套由 CSS 断点切换（见 30-rail.css） */}
          <SideRail me={me} view={view} onChange={changeView} isAdmin={me.isAdmin === true} />
          <TopNav me={me} view={view} onChange={changeView} isAdmin={me.isAdmin === true} />
          <div className="shell__body">
            {view === 'chat' ? (
              <ChatView
                me={me}
                notify={push}
                onLogout={() => void handleLogout()}
                onMobilePaneChange={setChatFocused}
              />
            ) : view === 'space' ? (
              <Suspense fallback={<ViewFallback />}>
                <SpaceView me={me} notify={push} />
              </Suspense>
            ) : view === 'friends' ? (
              <Suspense fallback={<ViewFallback />}>
                <FriendsView notify={push} />
              </Suspense>
            ) : view === 'admin' && me.isAdmin ? (
              <Suspense fallback={<ViewFallback />}>
                <AdminView notify={push} />
              </Suspense>
            ) : (
              <Suspense fallback={<ViewFallback />}>
                <MeView me={me} notify={push} onLogout={() => handleLogout()} onMeChange={setMe} />
              </Suspense>
            )}
          </div>
          <BottomTabBar
            view={view}
            onChange={changeView}
            hidden={view === 'chat' && chatFocused}
            isAdmin={me.isAdmin === true}
          />
        </div>
      )}
      <ToastStack items={items} />
    </>
  )
}
