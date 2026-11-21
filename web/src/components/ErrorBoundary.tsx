import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  /** 连续崩溃次数：让用户知道「重新加载」是不是又崩了 */
  reloaded: number
}

/**
 * 顶层错误边界：任何渲染期异常（含 lazy chunk 加载失败、后端返回了形状不符的数据）
 * 都会把整棵 React 树卸掉 → 白屏。以前没有任何边界，用户只能手动刷新（甚至以为网站挂了）。
 *
 * 边界只接**渲染/生命周期**里的错误，接不到事件处理器与异步 Promise（那些各自有 toast）。
 * 不做自动重试：同一份数据反复渲染会反复崩，自动重试会变成死循环 + 刷屏。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloaded: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 只记错误本身与组件栈，不记任何消息正文/用户数据
    console.error('[aio] 渲染崩溃', error, info.componentStack)
  }

  handleReload = () => {
    // 记住崩溃次数，避免用户以为点击没生效
    try {
      sessionStorage.setItem('aio:crash-count', String(this.state.reloaded + 1))
    } catch {
      /* 隐私模式下 sessionStorage 不可用，忽略 */
    }
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <h1 className="crash__title">页面出错了</h1>
          <p className="crash__hint">
            界面在渲染时遇到异常，已经停下，不会继续写入任何数据。重新加载通常能恢复；
            反复出现请把下面这行发给管理员。
          </p>
          <code className="crash__detail">{error.message || String(error)}</code>
          <div className="crash__actions">
            <button type="button" className="btn btn--primary" onClick={this.handleReload}>
              重新加载
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                window.location.href = '/'
              }}
            >
              回到首页
            </button>
          </div>
        </div>
      </div>
    )
  }
}
