// 表情包数据层（S1/S2）：
// - `GET /api/sticker-packs` 拉可见包（官方/公共 + 自己的私包 + 自己所在群的群包）
// - 读不到时回退到内置 8 个（web/public/packs/deepwhale-placeholder）
// - 最近使用存 localStorage，去重、最新在前、最多 24 条
// 组件通过 useStickerPacks() / useRecentStickers() 订阅，store 变更时自动刷新。

import { useEffect, useState } from 'react'
import type { StickerPack, StickerPackItem, StickerRecent } from './types'
import { api } from './api'
import { isValidStickerId, safeMediaUrl } from './parts'

/** 内置兜底包的 slug（消息里老数据也是这个） */
export const STICKER_PACK = 'deepwhale-placeholder'
const PACK_TITLE_FALLBACK = 'DeepWhale 占位鲸'

/** localStorage 键名沿用改名前的 `qqmini.*`：老用户的表情/草稿不能因为换品牌名而丢 */
export const RECENT_STICKER_KEY = 'qqmini.stickers.recent'
export const RECENT_STICKER_MAX = 24

const FALLBACK_ITEMS: Array<{ key: string; caption: string }> = [
  { key: 'ok', caption: '鲸鱼点头说 OK' },
  { key: 'laugh', caption: '鲸鱼笑到眼睛弯' },
  { key: 'cry', caption: '鲸鱼哭了' },
  { key: 'shock', caption: '鲸鱼震惊' },
  { key: 'angry', caption: '鲸鱼生气' },
  { key: 'love', caption: '鲸鱼比心' },
  { key: 'question', caption: '鲸鱼问号脸' },
  { key: 'sleep', caption: '鲸鱼睡着了' },
]

function fallbackItems(): StickerPackItem[] {
  return FALLBACK_ITEMS.map((item, index) => ({
    id: -(index + 1),
    key: item.key,
    caption: item.caption,
    tags: [],
    emotion: item.key,
    url: `/packs/${STICKER_PACK}/items/${item.key}.svg`,
  }))
}

function fallbackPack(): StickerPack {
  return {
    id: -1,
    slug: STICKER_PACK,
    title: PACK_TITLE_FALLBACK,
    scope: 'official',
    license: 'cc0',
    itemCount: FALLBACK_ITEMS.length,
    mine: false,
    items: fallbackItems(),
  }
}

/* ---------------- store ---------------- */

let packs: StickerPack[] | null = null
let loading = false
let loadError: string | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
/** slug+key → url 的索引，消息渲染时 O(1) 取图 */
let urlIndex: Map<string, string> = new Map()

function emit(): void {
  for (const listener of listeners) listener()
}

function reindex(): void {
  const map = new Map<string, string>()
  for (const pack of packs ?? []) {
    for (const item of pack.items) map.set(`${pack.slug}/${item.key}`, item.url)
  }
  urlIndex = map
}

function setPacks(next: StickerPack[]): void {
  packs = next
  reindex()
  emit()
}

export function getStickerPacks(): StickerPack[] {
  return packs ?? []
}

export function isStickerPackFallback(): boolean {
  return packs != null && packs.length === 1 && packs[0].id === -1
}

export function getStickerLoadError(): string | null {
  return loadError
}

/** 拉一次包列表；失败时回退内置包（不抛错，面板永远有东西可用） */
export function loadStickerPacks(force = false): Promise<void> {
  if (inflight && !force) return inflight
  loading = true
  loadError = null
  emit()
  inflight = (async () => {
    try {
      const res = await api.stickerPacks()
      const list = Array.isArray(res?.packs) ? res.packs : []
      setPacks(list.length > 0 ? list : [fallbackPack()])
    } catch (err) {
      // 未登录 / 网络失败都退回内置 8 个，面板不至于空着
      loadError = err instanceof Error ? err.message : '表情包加载失败'
      setPacks([fallbackPack()])
    } finally {
      loading = false
      inflight = null
      emit()
    }
  })()
  return inflight
}

/** 用接口返回的包覆盖本地（新建/加表情/删表情/分享后调用） */
export function applyStickerPack(pack: StickerPack): void {
  const current = packs ?? []
  const index = current.findIndex((item) => item.id === pack.id)
  const next = index >= 0 ? current.map((item) => (item.id === pack.id ? pack : item)) : [...current, pack]
  setPacks(next)
}

export function removeStickerPackFromStore(packId: number): void {
  setPacks((packs ?? []).filter((item) => item.id !== packId))
}

/** 消息渲染用：pack=slug。找不到就用静态目录约定兜底（官方内置包就是这个形状）
 *  非法 pack/key 返回 null：它们会被拼进 `/packs/${pack}/items/${key}.svg`，不设白名单等于
 *  让消息内容决定同源图片路径（前端评审 V1）。调用方（MessageContent）收到 null 就不渲染图片。 */
export function stickerSrc(pack: string, key: string): string | null {
  if (!isValidStickerId(pack) || !isValidStickerId(key)) return null
  const hit = urlIndex.get(`${pack}/${key}`)
  // 索引里的 url 也来自接口，同样过一遍地址白名单；不合规就回落到目录约定路径
  if (hit && safeMediaUrl(hit)) return hit
  return `/packs/${pack}/items/${key}.svg`
}

/** 在已加载的包里找某条表情（最近使用要拿 url/caption） */
export function findStickerItem(pack: string, key: string): StickerPackItem | null {
  for (const p of packs ?? []) {
    if (p.slug !== pack) continue
    const hit = p.items.find((item) => item.key === key)
    if (hit) return hit
  }
  return findStickerItemInFallback(pack, key)
}

function findStickerItemInFallback(pack: string, key: string): StickerPackItem | null {
  if (pack !== STICKER_PACK) return null
  return fallbackItems().find((item) => item.key === key) ?? null
}

export function findStickerPackBySlug(slug: string): StickerPack | null {
  return (packs ?? []).find((pack) => pack.slug === slug) ?? null
}

export function findStickerPackById(id: number): StickerPack | null {
  return (packs ?? []).find((pack) => pack.id === id) ?? null
}

/** 订阅包列表（组件首次渲染就有兜底数据，加载完自动刷新） */
export function useStickerPacks(): { packs: StickerPack[]; loading: boolean; error: string | null } {
  const [, bump] = useState(0)
  useEffect(() => {
    let alive = true
    const listener = () => {
      if (alive) bump((n) => n + 1)
    }
    listeners.add(listener)
    void loadStickerPacks()
    return () => {
      alive = false
      listeners.delete(listener)
    }
  }, [])
  return { packs: getStickerPacks(), loading, error: loadError }
}

/* ---------------- 最近使用 ---------------- */

let recentCache: StickerRecent[] | null = null
const recentListeners = new Set<() => void>()

function isRecent(value: unknown): value is StickerRecent {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.pack === 'string' && record.pack.length > 0 && typeof record.key === 'string' && record.key.length > 0
}

export function getRecentStickers(): StickerRecent[] {
  if (recentCache) return recentCache
  try {
    const raw = window.localStorage.getItem(RECENT_STICKER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const list = Array.isArray(parsed) ? parsed.filter(isRecent) : []
    recentCache = list.slice(0, RECENT_STICKER_MAX)
  } catch {
    recentCache = []
  }
  return recentCache
}

/** 发送成功后调用：去重、最新在前、最多 24 条 */
export function pushRecentSticker(pack: string, key: string): void {
  if (!pack || !key) return
  const next = [
    { pack, key },
    ...getRecentStickers().filter((item) => !(item.pack === pack && item.key === key)),
  ].slice(0, RECENT_STICKER_MAX)
  recentCache = next
  try {
    window.localStorage.setItem(RECENT_STICKER_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式 / 配额满：只影响「最近」持久化，不影响发送
  }
  for (const listener of recentListeners) listener()
}

export function useRecentStickers(): StickerRecent[] {
  const [, bump] = useState(0)
  useEffect(() => {
    let alive = true
    const listener = () => {
      if (alive) bump((n) => n + 1)
    }
    recentListeners.add(listener)
    return () => {
      alive = false
      recentListeners.delete(listener)
    }
  }, [])
  return getRecentStickers()
}
