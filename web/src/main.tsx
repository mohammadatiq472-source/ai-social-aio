import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installPushResubscribeHandler } from './push-client'
import './styles.css'

// 推送订阅轮换兜底：SW 在 pushsubscriptionchange 里拿不到公钥时会给页面投递消息，
// 由页面用登录态重订阅（见 push-client.ts）。挂在模块顶层，整个应用生命周期只挂一次。
installPushResubscribeHandler()

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    {/* 顶层错误边界：渲染期异常（含 lazy chunk 404）不再白屏，给「重新加载」出口 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
