// 浏览器侧 Web Push：申请权限 → 注册 Service Worker → pushManager.subscribe → 交给后端入库。
// 只支持「安全上下文」（https 或 localhost）；iOS 需要把站点加到主屏（16.4+）才有 Push。
// 失败原因要能说人话：用户看到「开启通知」点了没反应，比报错更糟。

import { api } from './api'

/** SW 在「拿不到 VAPID 公钥 / 自己在 SW 里重订阅失败」时投递的消息类型。
 *  两个文件各写一份（public/sw.js 不经打包，无法 import 常量）——改一处必须改另一处。 */
export const RESUBSCRIBE_MESSAGE = 'aio:resubscribe-push'

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** VAPID 公钥是 base64url，subscribe() 要 Uint8Array */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing) return existing
  return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    return sub?.endpoint ?? null
  } catch {
    return null
  }
}

/** 返回 { endpoint, keys } 或抛错（错误 message 直接给用户看） */
export async function enablePush(publicKey: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  if (!pushSupported()) throw new Error('这个浏览器不支持系统通知（iOS 需要先「添加到主屏幕」）')
  if (!publicKey) throw new Error('服务器没有配置通知密钥')
  if (Notification.permission === 'denied') throw new Error('通知权限被拒绝：请在浏览器设置里允许本站通知')
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('没有拿到通知权限')

  const reg = await registration()
  const existing = await reg.pushManager.getSubscription()
  // 换过账号时旧订阅还在：先退掉，否则会把消息推给上一个人
  if (existing) {
    try {
      await existing.unsubscribe()
    } catch {
      /* 退不掉就接着用新的 */
    }
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('浏览器没有返回完整的订阅信息')
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }
}

/** 关掉通知：先在浏览器退订，再让后端删记录；返回被删掉的 endpoint */
export async function disablePush(): Promise<string | null> {
  if (!pushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return null
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    return endpoint
  } catch {
    return null
  }
}

/**
 * 订阅轮换的页面侧兜底（前端评审 T1）。
 * SW 在 pushsubscriptionchange 里自己重订阅需要 VAPID 公钥；拿不到（老版本后端没有
 * /api/push/key、离线、服务端没配密钥）或者 SW 内入库失败时，它会 postMessage 这条消息。
 * 页面此时有登录态，直接走和「用户点开启通知」同一条链路即可。
 */
export function installPushResubscribeHandler(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string } | null
    if (!data || data.type !== RESUBSCRIBE_MESSAGE) return
    void resubscribeFromPage()
  })
}

async function resubscribeFromPage(): Promise<void> {
  try {
    // 权限被用户收回时不能偷偷再订阅（Safari 会直接抛，且这属于用户意愿）
    if (Notification.permission !== 'granted') return
    const key = await api.pushKey()
    if (!key.enabled || !key.key) return
    // enablePush 会先退掉浏览器里的旧订阅再注册新的，正好补上「SW 订上了但没入库」的缺口
    const sub = await enablePush(key.key)
    await api.pushSubscribe(sub)
  } catch {
    // 轮换失败不打扰用户：页面照常可用，下次在「我的」页手动开通知即可
  }
}
