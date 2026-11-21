/* AIO Service Worker：只做三件事——显示推送、点通知回到对应会话、订阅轮换后重订阅。
   刻意不在这里做缓存/离线：本站是单页应用 + 实时 WS，缓存只会让版本更难对齐。
   推送内容由服务端最小化：会话名 + 发送者 + 前 40 字 + 会话 id（不发明文全文）。 */

const VAPID_KEY_ENDPOINT = '/api/push/key'
const PUSH_SUBSCRIBE_ENDPOINT = '/api/push/subscribe'
/** 与 src/push-client.ts 里的同名字符串保持一致 */
const RESUBSCRIBE_MESSAGE = 'aio:resubscribe-push'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/* ---------------- 订阅轮换（前端评审 T1） ----------------
   浏览器在 VAPID 密钥轮换、推送服务收回旧 endpoint 时会触发 pushsubscriptionchange。
   不处理它 = 服务端还留着旧订阅，用户从此静默收不到通知（不报错、界面上也看不出来）。

   为什么优先在 SW 里自己重订阅：这条链路在页面没打开时也能跑（PWA 被关掉时才最需要通知）。

   为什么公钥取 /api/push/key 而不是 /api/push/status：status 是登录态接口，只回
   { enabled, subscriptions }，不带公钥（src/http/routes.mjs:1728）；公钥在
   GET /api/push/key 里（无鉴权，就是给 pushManager.subscribe 用的）。

   降级（为什么必须留）：拿不到公钥（后端没配 VAPID / 离线 / 老版本后端没有该接口）时**不能**
   自己 subscribe —— 没有 applicationServerKey 的 subscribe 会抛错，硬凑出来的订阅也推不出消息。
   此时改为给每个已打开的页面投递 aio:resubscribe-push，由前端（src/push-client.ts）用登录态
   重走「取公钥 → subscribe → POST /api/push/subscribe」；一个页面都没开就等下次打开。
   注意本条链路也覆盖「SW 订阅成功但入库失败」：浏览器已有新订阅而服务端没有，页面重订阅会
   先退掉旧订阅再注册，正好补上。 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const renewed = await resubscribeHere()
      if (renewed) return
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) client.postMessage({ type: RESUBSCRIBE_MESSAGE })
    })(),
  )
})

/** 在 SW 内完成「重订阅 + 上报」；任何一步失败返回 null（交给页面降级） */
async function resubscribeHere() {
  const key = await fetchVapidKey()
  if (!key) return null
  let sub
  try {
    sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    })
  } catch {
    return null
  }
  try {
    const json = sub.toJSON()
    if (!json.endpoint || !json.keys || !json.keys.p256dh || !json.keys.auth) return null
    // 带 cookie：/api/push/subscribe 要登录态（服务端 currentUser）
    const res = await fetch(PUSH_SUBSCRIBE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    })
    return res.ok ? sub : null
  } catch {
    return null
  }
}

async function fetchVapidKey() {
  try {
    const res = await fetch(VAPID_KEY_ENDPOINT, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return ''
    const data = await res.json()
    if (!data || !data.enabled || !data.key) return ''
    return String(data.key)
  } catch {
    return ''
  }
}

/** VAPID 公钥是 base64url，subscribe() 要 Uint8Array。
 *  SW 里没有 window，直接用 WorkerGlobalScope 上的全局 atob。 */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}


self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const conversationId = data.conversationId || null
  const title = data.title || '新消息'
  const body = data.body || ''
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // 同一个会话的通知合并成一条，别在锁屏上堆一列
      tag: data.tag || (conversationId ? `conv-${conversationId}` : undefined),
      renotify: Boolean(data.mention),
      data: { conversationId, url: conversationId ? `/?c=${conversationId}` : '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data || {}
  const url = target.url || '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        // 已经开着页面：直接跳过去（navigate 失败就只聚焦，别把用户的页面弄丢）
        try {
          if ('navigate' in client && client.url !== url) await client.navigate(url)
        } catch {
          /* 忽略：navigate 不是所有浏览器都支持 */
        }
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    })(),
  )
})
