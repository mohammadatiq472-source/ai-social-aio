// 消息段（parts）归一化与展示用小工具。
// 后端读路径存在 snake_case（attachment_id）与 camelCase 两种写法，这里统一吃下来。

import type {
  FileEntry,
  FilePart,
  HtmlPart,
  ImagePart,
  MessagePart,
  StickerPart,
  VideoPart,
  VoicePart,
} from './types'

/** 允许上传的图片类型（服务端同样白名单校验） */
export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 语音上限（服务端 8MB；前端按 60 秒截断） */
export const MAX_VOICE_BYTES = 8 * 1024 * 1024
export const MAX_VOICE_MS = 60_000
/** 视频上限（服务端 40MB） */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024
/** 一条消息最多 5 段（服务端限制） */
export const MAX_PARTS = 5
/** 外链 url 长度上限（契约 §2.1） */
export const MAX_RICH_URL = 2048
/** 文件包清单最多展示 50 条（契约 §2.1） */
export const MAX_FILE_ENTRIES = 50
/** srcdoc 上限 24KB（契约 §2.1） */
export const MAX_SRCDOC_CHARS = 24_576
/** HTML 预览高度：默认 320，夹在 160..640（契约 §4） */
export const HTML_FRAME_MIN_HEIGHT = 160
export const HTML_FRAME_MAX_HEIGHT = 640
export const HTML_FRAME_DEFAULT_HEIGHT = 320

export interface WirePart {
  type: string
  text?: string
  attachment_id?: number
  poster_attachment_id?: number
  pack?: string
  key?: string
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 表情包 slug / 表情 key 的白名单：只允许字母数字下划线连字符，1..64 位。
 * 为什么必须有：这两个值会被拼进图片地址 `/packs/${pack}/items/${key}.svg`，
 * 不加限制就能用 `../` 之类构造任意同源路径（前端评审 V1）。
 * 定义在协议归一化层，渲染层（stickers.ts#stickerSrc）复用同一个判断。
 */
const STICKER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** pack/key 是否合法（供 normalizeSticker 与 stickers.ts#stickerSrc 共用） */
export function isValidStickerId(value: unknown): value is string {
  return typeof value === 'string' && STICKER_ID_RE.test(value)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 站内附件地址是相对路径（`/media/12?e=…&s=…`），外链必须是 https。
 * 其它协议（javascript:/data:/file:/http:）一律返回 null，绝不进入 href/src。
 */
function safeUrl(value: unknown, options: { allowRelative: boolean }): string | null {
  const raw = asString(value)?.trim()
  if (!raw || raw.length > MAX_RICH_URL) return null
  // 站内相对路径：必须以单个 "/" 开头，且不能是 "//"（协议相对）或带反斜杠的绕过写法
  if (options.allowRelative && raw.startsWith('/')) {
    if (raw.startsWith('//') || raw.includes('\\')) return null
    return raw
  }
  if (!/^https:\/\//i.test(raw)) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') return null
    // 契约 §2.1：不允许 user:pass@
    if (parsed.username || parsed.password) return null
    return raw
  } catch {
    return null
  }
}

/** 图片/语音/视频段用的地址：允许站内相对路径（历史附件）与外链 https */
export function safeMediaUrl(value: unknown): string | null {
  return safeUrl(value, { allowRelative: true })
}

/** 文件包 / HTML 预览的地址：只认外链 https（契约 §2.1） */
export function safeRichUrl(value: unknown): string | null {
  return safeUrl(value, { allowRelative: false })
}

/** 字节数 → 人类可读；缺失 / 非法（负数、NaN）时返回空串，卡片不显示假数据 */
export function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${units[unit]}`
}

/** HTML 预览高度：缺省 320，夹在 160..640，非法值回落默认 */
export function clampHtmlHeight(height?: number | null): number {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return HTML_FRAME_DEFAULT_HEIGHT
  return Math.min(HTML_FRAME_MAX_HEIGHT, Math.max(HTML_FRAME_MIN_HEIGHT, Math.round(height)))
}

/** 从 url 里取域名给卡片做副标题（解析失败返回空串） */
export function hostOf(url?: string | null): string {
  if (!url) return ''
  try {
    return new URL(url, 'https://localhost').hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** 32 位 FNV-1a：给 srcdoc 这类大文本做稳定短指纹（只用于归位比对，不参与安全判断） */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function normalizeImage(record: Record<string, unknown>): MessagePart {
  const id = asNumber(record.attachment_id) ?? asNumber(record.attachmentId) ?? 0
  const url = safeMediaUrl(record.url)
  if (id <= 0 && !url) return { type: 'unsupported', rawType: 'image' }
  const part: ImagePart = { type: 'image', attachmentId: id }
  const mime = asString(record.mime)
  if (mime) part.mime = mime
  const bytes = asNumber(record.bytes)
  if (bytes != null) part.bytes = bytes
  const width = asNumber(record.width)
  if (width != null) part.width = width
  const height = asNumber(record.height)
  if (height != null) part.height = height
  const alt = asString(record.alt)?.trim()
  if (alt) part.alt = alt.slice(0, 120)
  if (url) part.url = url
  // 缩略图只用于气泡展示（灯箱仍走 url）：不是合法媒体地址就当没有，宁可加载原图也不要一个坏 src。
  // 这里是字段白名单，漏掉它 = 后端带了 thumbUrl 也到不了 ImageBlock（MessageList 每次渲染都会过这里）。
  const thumb = safeMediaUrl(record.thumbUrl)
  if (thumb) part.thumbUrl = thumb
  // 扫描态必须显式透传：这里也是字段白名单，漏掉就变成「后端拦了、前端只说图片不可用」，
  // 用户会以为图坏了去重发（Q6 的语义是"在审核"，不是失败）。
  if (record.pending === true) part.pending = true
  if (record.blocked === true) part.blocked = true
  return part
}

function normalizeSticker(record: Record<string, unknown>): MessagePart {
  const pack = asString(record.pack)
  const key = asString(record.key)
  // 白名单不放行就当「不支持的段」：渲染层没有可靠的纠错手段，宁可显示占位
  if (!isValidStickerId(pack) || !isValidStickerId(key)) return { type: 'unsupported', rawType: 'sticker' }
  const part: StickerPart = { type: 'sticker', pack, key }
  const caption = asString(record.caption)
  if (caption) part.caption = caption
  return part
}

function normalizeVoice(record: Record<string, unknown>): MessagePart {
  const id = asNumber(record.attachment_id) ?? asNumber(record.attachmentId) ?? 0
  const url = safeMediaUrl(record.url)
  if (id <= 0 && !url) return { type: 'unsupported', rawType: 'voice' }
  const part: VoicePart = { type: 'voice', attachmentId: id }
  const mime = asString(record.mime)
  if (mime) part.mime = mime
  const bytes = asNumber(record.bytes)
  if (bytes != null) part.bytes = bytes
  const duration = asNumber(record.durationMs) ?? asNumber(record.duration_ms)
  if (duration != null) part.durationMs = duration
  if (url) part.url = url
  if (record.pending === true) part.pending = true
  if (record.blocked === true) part.blocked = true
  return part
}

function normalizeVideo(record: Record<string, unknown>): MessagePart {
  const id = asNumber(record.attachment_id) ?? asNumber(record.attachmentId) ?? 0
  const url = safeMediaUrl(record.url)
  if (id <= 0 && !url) return { type: 'unsupported', rawType: 'video' }
  const part: VideoPart = { type: 'video', attachmentId: id }
  const mime = asString(record.mime)
  if (mime) part.mime = mime
  const bytes = asNumber(record.bytes)
  if (bytes != null) part.bytes = bytes
  const width = asNumber(record.width)
  if (width != null) part.width = width
  const height = asNumber(record.height)
  if (height != null) part.height = height
  const duration = asNumber(record.durationMs) ?? asNumber(record.duration_ms)
  if (duration != null) part.durationMs = duration
  const posterId = asNumber(record.poster_attachment_id) ?? asNumber(record.posterAttachmentId)
  if (posterId != null && posterId > 0) part.posterAttachmentId = posterId
  const posterUrl = safeMediaUrl(record.posterUrl) ?? safeMediaUrl(record.poster_url)
  if (posterUrl) part.posterUrl = posterUrl
  if (url) part.url = url
  if (record.pending === true) part.pending = true
  if (record.blocked === true) part.blocked = true
  return part
}

/** 文件包清单的一项：名字必填，大小可选；空名字直接丢掉 */
function normalizeFileEntry(value: unknown): FileEntry | null {
  if (value == null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = asString(record.name)?.trim()
  if (!name) return null
  const entry: FileEntry = { name: name.slice(0, 80) }
  const bytes = asNumber(record.bytes)
  if (bytes != null && bytes >= 0) entry.bytes = Math.trunc(bytes)
  return entry
}

function normalizeFile(record: Record<string, unknown>): MessagePart {
  const url = safeRichUrl(record.url)
  const name = asString(record.name)?.trim()
  if (!url || !name) return { type: 'unsupported', rawType: 'file' }
  const part: FilePart = { type: 'file', url, name: name.slice(0, 60) }
  const bytes = asNumber(record.bytes)
  if (bytes != null && bytes >= 0) part.bytes = Math.trunc(bytes)
  const mime = asString(record.mime)?.trim()
  if (mime) part.mime = mime.slice(0, 80)
  const rawFiles = Array.isArray(record.files) ? record.files : []
  const files = rawFiles
    .map(normalizeFileEntry)
    .filter((entry): entry is FileEntry => entry != null)
    .slice(0, MAX_FILE_ENTRIES)
  if (files.length > 0) part.files = files
  return part
}

function normalizeHtml(record: Record<string, unknown>): MessagePart {
  const url = safeRichUrl(record.url)
  const rawSrcdoc = asString(record.srcdoc)
  const srcdoc = rawSrcdoc && rawSrcdoc.trim().length > 0 ? rawSrcdoc.slice(0, MAX_SRCDOC_CHARS) : null
  // url 优先；只有没有 url 时才用 srcdoc
  if (!url && !srcdoc) return { type: 'unsupported', rawType: 'html' }
  const part: HtmlPart = url ? { type: 'html', url } : { type: 'html', srcdoc }
  const title = asString(record.title)?.trim()
  if (title) part.title = title.slice(0, 60)
  const height = asNumber(record.height)
  // 归一化只保证是有限的非负数；夹到 160..640 是渲染时的事（clampHtmlHeight）
  if (height != null && height > 0) part.height = Math.min(10_000, height)
  return part
}

/**
 * 把后端给的 parts 归一成前端联合类型。
 * 老消息没有 parts（或 parts 为空）时，回退到 body 文本——绝不能因此白屏。
 */
export function normalizeParts(raw: unknown, body?: string | null): MessagePart[] {
  const list = Array.isArray(raw) ? raw : []
  const out: MessagePart[] = []

  for (const item of list) {
    if (item == null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const type = (asString(record.type) ?? '').trim()
    if (!type) continue

    if (type === 'text') {
      const text = asString(record.text) ?? ''
      if (text.length > 0) out.push({ type: 'text', text })
      continue
    }
    if (type === 'image') {
      out.push(normalizeImage(record))
      continue
    }
    if (type === 'sticker') {
      out.push(normalizeSticker(record))
      continue
    }
    if (type === 'voice') {
      out.push(normalizeVoice(record))
      continue
    }
    if (type === 'video') {
      out.push(normalizeVideo(record))
      continue
    }
    if (type === 'file') {
      out.push(normalizeFile(record))
      continue
    }
    if (type === 'html') {
      out.push(normalizeHtml(record))
      continue
    }
    out.push({ type: 'unsupported', rawType: type })
  }

  if (out.length === 0) {
    const fallback = (body ?? '').trim()
    if (fallback) out.push({ type: 'text', text: fallback })
  }
  return out
}

/** 会话列表 / 引用条用的一句话预览 */
export function previewOf(parts: MessagePart[], body?: string | null): string {
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim()) return part.text
    if (part.type === 'image') return '[图片]'
    if (part.type === 'sticker') return '[表情]'
    if (part.type === 'voice') return '[语音]'
    if (part.type === 'video') return '[视频]'
    if (part.type === 'file') return '[文件]'
    if (part.type === 'html') return '[网页]'
  }
  return (body ?? '').trim()
}

/**
 * 同一组段落的指纹：用于 WS 回包时把乐观消息归位（老逻辑是比 body）。
 * 注意：纯外链段没有 attachmentId，必须用 url 做指纹，否则两条外链消息会互相顶掉。
 */
export function signatureOf(parts: MessagePart[], body?: string | null): string {
  const list = parts.length > 0 ? parts : normalizeParts(undefined, body)
  return list
    .map((part) => {
      if (part.type === 'text') return `t:${part.text}`
      if (part.type === 'image') return part.attachmentId > 0 ? `i:${part.attachmentId}` : `i:u:${part.url ?? ''}`
      if (part.type === 'sticker') return `s:${part.pack}/${part.key}`
      if (part.type === 'voice') return part.attachmentId > 0 ? `v:${part.attachmentId}` : `v:u:${part.url ?? ''}`
      if (part.type === 'video') return part.attachmentId > 0 ? `m:${part.attachmentId}` : `m:u:${part.url ?? ''}`
      if (part.type === 'file') return `f:${part.url}`
      // url 优先；纯 srcdoc 用短指纹（内容可能上万字，不能塞进指纹里）
      if (part.type === 'html') return part.url ? `h:u:${part.url}` : `h:s:${fnv1a(part.srcdoc ?? '')}`
      return 'u:'
    })
    .join('|')
}

/**
 * 发给服务端的最小 parts 形态（只带引用，不带签名 url 等展示字段）。
 * file / html 是 Agent 侧的外链段，人类发送不产生它们，这里直接跳过。
 */
export function toWireParts(parts: MessagePart[]): WirePart[] {
  const wire: WirePart[] = []
  for (const part of parts) {
    if (part.type === 'text') wire.push({ type: 'text', text: part.text })
    else if (part.type === 'image' && part.attachmentId > 0) wire.push({ type: 'image', attachment_id: part.attachmentId })
    else if (part.type === 'sticker') wire.push({ type: 'sticker', pack: part.pack, key: part.key })
    else if (part.type === 'voice' && part.attachmentId > 0) wire.push({ type: 'voice', attachment_id: part.attachmentId })
    else if (part.type === 'video' && part.attachmentId > 0) {
      const v: WirePart = { type: 'video', attachment_id: part.attachmentId }
      if (part.posterAttachmentId) v.poster_attachment_id = part.posterAttachmentId
      wire.push(v)
    }
  }
  return wire
}

/** 图片段是否带可用的宽高（决定等比还是 200×200 裁切） */
export function hasImageSize(part: ImagePart): boolean {
  return typeof part.width === 'number' && part.width > 0 && typeof part.height === 'number' && part.height > 0
}

/** 语音时长 → 展示用秒数（向上取整，至少 1 秒，和 QQ 一致） */
export function voiceSeconds(durationMs?: number | null): number {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return 1
  return Math.max(1, Math.ceil(durationMs / 1000))
}

/** 语音胶囊宽度：随时长增长，60 秒封顶（118 → 220px） */
export function voiceWidth(durationMs?: number | null): number {
  const seconds = Math.min(60, Math.max(1, (typeof durationMs === 'number' ? durationMs : 0) / 1000))
  return Math.round(118 + (seconds / 60) * 102)
}
