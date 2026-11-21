// WebSocket 客户端：同源 /ws，自动重连 + 心跳 + 半开连接检测 + 断线状态回调。
//
// 半开连接（外部评审前端 §4-2）：手机切网 / 系统休眠后 TCP 已经死了，但浏览器不会触发
// onclose——界面继续显示「已连接」，期间消息全丢，直到 TCP 自己超时（可能几分钟）。
// 做法：每次 ping 之后等 pong；5 秒没等到就主动 close()，让 onclose 走正常的重连流程。
// 另外监听浏览器 online/offline：断网立刻标离线，恢复立刻重连（不必等心跳超时）。
import type { WsServerFrame, WsStatus } from './types'

export interface SocketHandlers {
  onStatus: (status: WsStatus) => void
  onFrame: (frame: WsServerFrame) => void
}

const PING_INTERVAL = 20000
/** ping 之后多久没 pong 就判定连接已死 */
const PONG_TIMEOUT = 5000
const MAX_BACKOFF = 15000

export class ChatSocket {
  private ws: WebSocket | null = null
  private explicitlyClosed = false
  private retries = 0
  private pingTimer: number | null = null
  private pongTimer: number | null = null
  private retryTimer: number | null = null
  private readonly handlers: SocketHandlers
  private readonly onOnline: () => void
  private readonly onOffline: () => void

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers
    // 浏览器网络状态变化：断网时不假装在线；恢复时不用等心跳，立刻重连
    this.onOnline = () => {
      if (this.explicitlyClosed) return
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect()
    }
    this.onOffline = () => {
      this.handlers.onStatus('offline')
    }
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.explicitlyClosed = false
    this.handlers.onStatus(this.retries === 0 ? 'connecting' : 'reconnecting')

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      this.retries = 0
      this.handlers.onStatus('online')
      this.startPing()
    }

    ws.onmessage = (event: MessageEvent) => {
      let frame: WsServerFrame | null = null
      try {
        frame = JSON.parse(String(event.data)) as WsServerFrame
      } catch {
        return
      }
      if (frame && typeof frame === 'object' && 't' in frame) {
        // 收到任何帧都说明链路活着：清掉 pong 超时计时器
        if (frame.t === 'pong') this.clearPongTimer()
        this.handlers.onFrame(frame)
      }
    }

    ws.onerror = () => {
      // onclose 会紧跟着触发，这里不重复处理
    }

    ws.onclose = () => {
      this.stopPing()
      this.clearPongTimer()
      this.ws = null
      if (this.explicitlyClosed) {
        this.handlers.onStatus('offline')
        return
      }
      // 浏览器自己报离线时不要疯狂重试：等 online 事件再连（backoff 仍保留兜底）
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this.handlers.onStatus('offline')
        return
      }
      this.retries += 1
      this.handlers.onStatus('reconnecting')
      const delay = Math.min(1000 * 2 ** (this.retries - 1), MAX_BACKOFF)
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null
        this.connect()
      }, delay)
    }
  }

  send(frame: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  close(): void {
    this.explicitlyClosed = true
    this.stopPing()
    this.clearPongTimer()
    if (this.retryTimer != null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    this.ws?.close()
    this.ws = null
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = window.setInterval(() => {
      const sent = this.send({ t: 'ping' })
      if (!sent) return
      // 上一轮 pong 还没等到就再发 ping：只保留最新一次计时，超时直接判定连接已死
      this.clearPongTimer()
      this.pongTimer = window.setTimeout(() => {
        this.pongTimer = null
        // 半开连接：主动 close，把 onclose 的「重连 + 按 since_seq 补齐」流程叫起来
        try {
          this.ws?.close()
        } catch {
          /* 已经关了 */
        }
      }, PONG_TIMEOUT)
    }, PING_INTERVAL)
  }

  private clearPongTimer(): void {
    if (this.pongTimer != null) {
      window.clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private stopPing(): void {
    if (this.pingTimer != null) {
      window.clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
