// 小工具集合：时间格式化、类名、颜色、UUID。

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

/** 复制文本：优先 Clipboard API，失败回退 execCommand。返回是否成功。 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.focus()
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** 生成 client_msg_id（uuid v4）。非安全上下文下 crypto.randomUUID 可能缺失，故带兜底。 */
export function makeClientMsgId(): string {
  const cryptoObj = window.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 气泡时间：HH:MM */
export function formatClock(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 会话列表时间：今天显示 HH:MM，昨天显示「昨天」，更早显示 M/D */
export function formatListTime(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return formatClock(iso)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 「上次同步」相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function formatRelative(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return '未知'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 日期分隔线文案 */
export function formatDayLabel(iso: string): string {
  const d = toDate(iso)
  if (!d) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 说说时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / 日期 */
export function formatFeedTime(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return ''
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const clock = formatClock(iso)
  if (d.toDateString() === now.toDateString()) return `今天 ${clock}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${clock}`
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

export function avatarColor(hue: number | undefined): { background: string } {
  const h = typeof hue === 'number' && Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 210
  return { background: `hsl(${h} 62% 52%)` }
}

/** 头像里显示的字：取昵称第一个字符（支持 emoji / 中文） */
export function initialOf(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  return Array.from(trimmed)[0].toUpperCase()
}

/** 消息预览：折叠换行并截断 */
export function previewText(body: string, max = 40): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 引用条里的「原文前 N 字」 */
export function quoteOf(body: string, max = 20): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export const REPLY_MODE_TEXT: Record<string, string> = {
  off: '只看不回',
  low: '低 · 只回 @',
  mid: '中 · 可主动插话',
  high: '高 · 自由回复',
  // 旧的三个值做兼容显示（后端已自动映射到上面四档）
  mention: '低 · 只回 @',
  free: '高 · 自由回复',
}

export const ROLE_TEXT: Record<string, string> = {
  owner: '群主',
  admin: '管理员',
  member: '成员',
}

export const AGENT_STATUS_TEXT: Record<string, string> = {
  active: '运行中',
  paused: '已暂停',
  revoked: '已吊销',
}
