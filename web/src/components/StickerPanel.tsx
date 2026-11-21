import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { StickerPack, StickerPackItem } from '../types'
import { cn } from '../utils'
import {
  findStickerItem,
  getRecentStickers,
  loadStickerPacks,
  useRecentStickers,
  useStickerPacks,
} from '../stickers'
// 新建/详情两个弹窗只在点开后用得上：静态 import 会把 ~12.7KB（建包/加表情/删除表情）
// 一直挂在聊天首屏 chunk 里。改成打开时才拉；弹窗自身的焦点陷阱/关闭行为不变。
const CreatePackDialog = lazy(() =>
  import('./StickerPackDialog').then((mod) => ({ default: mod.CreatePackDialog })),
)
const PackDetailDialog = lazy(() =>
  import('./StickerPackDialog').then((mod) => ({ default: mod.PackDetailDialog })),
)

type StickerTab = 'recent' | 'all' | 'mine' | 'group'

interface StickerPanelProps {
  conversationId: number
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
  /** 发送一个表情（pack=包 slug）；成功后由 Composer 记「最近使用」 */
  onSend: (pack: string, key: string) => void
  onClose: () => void
}

const TABS: Array<{ key: StickerTab; label: string }> = [
  { key: 'recent', label: '最近' },
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我的' },
  { key: 'group', label: '群里的' },
]

function StickerGrid({
  items,
  onSend,
}: {
  items: Array<{ pack: string; item: StickerPackItem }>
  onSend: (pack: string, key: string) => void
}) {
  return (
    <div className="sticker-panel__grid">
      {items.map(({ pack, item }) => (
        <button
          key={`${pack}/${item.key}`}
          type="button"
          className="sticker-item"
          title={item.caption || item.key}
          aria-label={item.caption || item.key}
          onClick={() => onSend(pack, item.key)}
        >
          <img src={item.url} alt={item.caption || item.key} width={56} height={56} loading="lazy" />
        </button>
      ))}
    </div>
  )
}

function PackGroup({
  pack,
  onSend,
}: {
  pack: StickerPack
  onSend: (pack: string, key: string) => void
}) {
  if (pack.items.length === 0) return null
  return (
    <section className="sticker-group">
      <h4 className="sticker-group__title">{pack.title}</h4>
      <StickerGrid items={pack.items.map((item) => ({ pack: pack.slug, item }))} onSend={onSend} />
    </section>
  )
}

/** 表情面板：最近 / 全部 / 我的 / 群里的；我的分段里可建包、进包详情。 */
export function StickerPanel({ conversationId, notify, onSend, onClose }: StickerPanelProps) {
  const { packs, loading, error } = useStickerPacks()
  const recent = useRecentStickers()
  const [tab, setTab] = useState<StickerTab>(() => (getRecentStickers().length > 0 ? 'recent' : 'all'))
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  const myPacks = useMemo(() => packs.filter((pack) => pack.scope === 'private'), [packs])
  const groupPacks = useMemo(() => packs.filter((pack) => pack.scope === 'group'), [packs])
  const hasAnyItem = packs.some((pack) => pack.items.length > 0)

  // 数据变化后如果当前分段空了，自动退到合适的分段（首帧加载中不要乱跳）
  useEffect(() => {
    if (loading && packs.length === 0) return
    if (tab === 'group' && groupPacks.length === 0) {
      setTab('all')
      return
    }
    if (tab === 'all' && packs.length > 0 && !hasAnyItem) setTab('mine')
  }, [tab, loading, packs.length, groupPacks.length, hasAnyItem])

  const recentItems = useMemo(
    () =>
      recent
        .map((entry) => {
          const item = findStickerItem(entry.pack, entry.key)
          return item ? { pack: entry.pack, item } : null
        })
        .filter((entry): entry is { pack: string; item: StickerPackItem } => entry != null),
    [recent, packs],
  )

  const detailPack = detailId != null ? packs.find((pack) => pack.id === detailId) ?? null : null

  const visibleTabs = TABS.filter((entry) => {
    if (entry.key === 'group') return groupPacks.length > 0
    return true
  })

  function renderBody() {
    if (loading && packs.length === 0) {
      return <p className="sticker-panel__state">正在加载表情…</p>
    }

    if (tab === 'recent') {
      if (recentItems.length === 0) return <p className="sticker-panel__state">还没发过表情</p>
      return <StickerGrid items={recentItems} onSend={onSend} />
    }

    if (tab === 'all') {
      if (!hasAnyItem) return <p className="sticker-panel__state">还没有表情包</p>
      // 「全部」= 当前可见的所有包（官方/公共 + 我的私包 + 群包），按包分组
      return packs.map((pack) => <PackGroup key={pack.id} pack={pack} onSend={onSend} />)
    }

    if (tab === 'group') {
      if (groupPacks.length === 0) return <p className="sticker-panel__state">这个群还没有表情包</p>
      return groupPacks.map((pack) => <PackGroup key={pack.id} pack={pack} onSend={onSend} />)
    }

    // 我的：建包入口 + 包列表（点开管理）
    return (
      <>
        <button type="button" className="sticker-create" onClick={() => setCreateOpen(true)}>
          <span className="sticker-create__icon" aria-hidden="true">
            ＋
          </span>
          新建表情包
        </button>
        {myPacks.length === 0 ? (
          <p className="sticker-panel__state">还没有自己的表情包</p>
        ) : (
          myPacks.map((pack) => (
            <button key={pack.id} type="button" className="sticker-pack-card" onClick={() => setDetailId(pack.id)}>
              <span className="sticker-pack-card__thumbs" aria-hidden="true">
                {pack.items.slice(0, 3).map((item) => (
                  <img key={item.id} src={item.url} alt="" width={32} height={32} loading="lazy" />
                ))}
                {pack.items.length === 0 ? <span className="sticker-pack-card__empty">空</span> : null}
              </span>
              <span className="sticker-pack-card__meta">
                <span className="sticker-pack-card__title">{pack.title}</span>
                <span className="sticker-pack-card__sub">{pack.itemCount} 个表情 · 点开管理</span>
              </span>
              <span className="sticker-pack-card__chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))
        )}
      </>
    )
  }

  return (
    <>
      <div className="sticker-panel" role="dialog" aria-label="表情">
        <div className="sticker-panel__head">
          <div className="sticker-tabs" role="tablist" aria-label="表情分类">
            {visibleTabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                className={cn('sticker-tab', tab === entry.key && 'sticker-tab--active')}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="sticker-panel__actions">
            {error ? (
              <button
                type="button"
                className="link-btn sticker-panel__retry"
                onClick={() => void loadStickerPacks(true)}
                title={error}
              >
                重试
              </button>
            ) : null}
            <button type="button" className="icon-btn sticker-panel__close" onClick={onClose} aria-label="关闭表情面板">
              ✕
            </button>
          </div>
        </div>

        {error ? <p className="sticker-panel__hint">表情包加载失败，已使用内置表情</p> : null}

        <div className="sticker-panel__body">{renderBody()}</div>
      </div>

      {createOpen ? (
        <Suspense fallback={null}>
          <CreatePackDialog
            notify={notify}
            onClose={() => setCreateOpen(false)}
            onCreated={(pack) => {
              setCreateOpen(false)
              setTab('mine')
              setDetailId(pack.id)
            }}
          />
        </Suspense>
      ) : null}

      {detailPack ? (
        <Suspense fallback={null}>
          <PackDetailDialog
            pack={detailPack}
            conversationId={conversationId}
            notify={notify}
            onClose={() => setDetailId(null)}
          />
        </Suspense>
      ) : null}
    </>
  )
}
