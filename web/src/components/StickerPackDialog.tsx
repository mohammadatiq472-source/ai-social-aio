import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { api, ApiError } from '../api'
import type { StickerPack, StickerPackItem } from '../types'
import { ALLOWED_IMAGE_MIMES, MAX_IMAGE_BYTES } from '../parts'
import { applyStickerPack, removeStickerPackFromStore } from '../stickers'
import { Modal } from './Modal'
import { ReportActionSheet } from './ReportActionSheet'

type Notify = (text: string, kind?: 'info' | 'success' | 'error') => void

const EMOTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不指定情绪' },
  { value: 'ok', label: 'OK / 同意' },
  { value: 'laugh', label: '笑 / 开心' },
  { value: 'sad', label: '难过 / 哭' },
  { value: 'angry', label: '生气' },
  { value: 'love', label: '爱 / 比心' },
  { value: 'shock', label: '震惊' },
  { value: 'question', label: '疑问' },
  { value: 'sleep', label: '困 / 晚安' },
]

const SCOPE_LABEL: Record<string, string> = {
  official: '官方',
  private: '我的私有',
  group: '群共享',
  public: '公共',
}

function captionFromFile(name: string): string {
  const base = (name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  return base.slice(0, 40) || '表情'
}

function isAllowedImage(mime: string): boolean {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)
}

interface CreatePackDialogProps {
  onClose: () => void
  onCreated: (pack: StickerPack) => void
  notify: Notify
}

/** 新建表情包：包名 1..24 字 */
export function CreatePackDialog({ onClose, onCreated, notify }: CreatePackDialogProps) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    const name = title.trim()
    if (name.length < 1 || name.length > 24) {
      setError('包名需要 1–24 个字')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await api.createStickerPack(name)
      applyStickerPack(res.pack)
      notify(`已创建「${res.pack.title}」`, 'success')
      onCreated(res.pack)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '创建失败，请重试'
      setError(message)
      notify(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建表情包"
      onClose={onClose}
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      }
    >
      <label className="field">
        <span className="field__label">包名（1–24 个字）</span>
        <input
          className="input"
          value={title}
          maxLength={24}
          autoFocus
          placeholder="例如：猫猫日常"
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </label>
      <p className="modal__hint">建好后可以往里加表情，也可以分享到群。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </Modal>
  )
}

interface PackDetailDialogProps {
  pack: StickerPack
  conversationId: number
  notify: Notify
  onClose: () => void
}

/** 包详情：加表情（选图→上传→入包）、长按/右键移除、分享到群、删除整包 */
export function PackDetailDialog({ pack, conversationId, notify, onClose }: PackDetailDialogProps) {
  const [busy, setBusy] = useState<'' | 'add' | 'share' | 'delete'>('')
  const [reportOpen, setReportOpen] = useState(false)
  const [emotion, setEmotion] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const longPressTimer = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (longPressTimer.current != null) window.clearTimeout(longPressTimer.current)
    }
  }, [])

  const canManage = pack.mine
  // 弹窗里再开 Modal 会让两层焦点陷阱抢 Esc，所以二次确认用就地确认条
  const [confirmAction, setConfirmAction] = useState<{ kind: 'remove'; item: StickerPackItem } | { kind: 'delete' } | null>(null)

  function clearLongPress() {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  async function removeItem(item: StickerPackItem) {
    if (!canManage || busy) return
    setConfirmAction(null)
    setBusy('add')
    try {
      const res = await api.removeStickerPackItem(pack.id, item.id)
      applyStickerPack(res.pack)
      notify('已移除该表情', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '移除失败，请重试', 'error')
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    if (!file || !canManage) return
    const mime = (file.type || '').toLowerCase()
    if (!isAllowedImage(mime)) {
      notify('只支持 JPG / PNG / WebP / GIF', 'error')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify('图片最大 8MB', 'error')
      return
    }
    setBusy('add')
    try {
      const uploaded = await api.uploadAttachment(file, mime)
      const res = await api.addStickerPackItem(pack.id, {
        attachmentId: uploaded.attachment.id,
        caption: captionFromFile(file.name),
        tags: [],
        emotion: emotion || null,
      })
      applyStickerPack(res.pack)
      notify('已添加表情', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '添加失败，请重试', 'error')
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  async function shareToGroup() {
    if (!canManage || busy) return
    setBusy('share')
    try {
      const res = await api.shareStickerPack(pack.id, conversationId)
      applyStickerPack(res.pack)
      notify('已分享到当前群', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '分享失败，请重试', 'error')
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  async function deletePack() {
    if (!canManage || busy) return
    setConfirmAction(null)
    setBusy('delete')
    try {
      await api.deleteStickerPack(pack.id)
      removeStickerPackFromStore(pack.id)
      notify('已删除表情包', 'success')
      onClose()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '删除失败，请重试', 'error')
      if (mounted.current) setBusy('')
    }
  }

  return (
    <Modal
      title={`「${pack.title}」`}
      onClose={onClose}
      wide
      footer={
        canManage ? (
          <div className="pack-detail__actions">
            <button
              type="button"
              className="btn"
              onClick={() => void shareToGroup()}
              disabled={busy !== ''}
              title="把整个包分享到当前会话（需要群主/管理员）"
            >
              {busy === 'share' ? '分享中…' : '分享到当前群'}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setConfirmAction({ kind: 'delete' })}
              disabled={busy !== ''}
            >
              {busy === 'delete' ? '删除中…' : '删除整个包'}
            </button>
          </div>
        ) : (
          <div className="pack-detail__actions">
            <button type="button" className="btn" onClick={() => setReportOpen(true)}>
              举报这个包
            </button>
          </div>
        )
      }
    >
      <div className="pack-detail">
        <p className="pack-detail__meta">
          {SCOPE_LABEL[pack.scope] ?? pack.scope} · {pack.itemCount} 个表情
          {canManage ? ' · 长按或右键表情可移除' : ''}
        </p>

        {confirmAction ? (
          <div className="confirm-bar" role="alertdialog" aria-label="确认操作">
            <span className="confirm-bar__text">
              {confirmAction.kind === 'delete'
                ? `确定删除表情包「${pack.title}」？包里的 ${pack.itemCount} 个表情会一起删除，无法恢复。`
                : `从「${pack.title}」里移除「${confirmAction.item.caption || confirmAction.item.key}」？`}
            </span>
            <span className="confirm-bar__actions">
              <button type="button" className="btn btn--sm" onClick={() => setConfirmAction(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => {
                  if (confirmAction.kind === 'delete') void deletePack()
                  else void removeItem(confirmAction.item)
                }}
              >
                确认
              </button>
            </span>
          </div>
        ) : null}

        <div className="pack-detail__grid">
          {pack.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="pack-detail__item"
              title={canManage ? `${item.caption || item.key}（长按移除）` : item.caption || item.key}
              onContextMenu={(event) => {
                event.preventDefault()
                setConfirmAction({ kind: 'remove', item })
              }}
              onPointerDown={() => {
                if (!canManage) return
                clearLongPress()
                suppressClick.current = false
                longPressTimer.current = window.setTimeout(() => {
                  longPressTimer.current = null
                  suppressClick.current = true
                  setConfirmAction({ kind: 'remove', item })
                }, 600)
              }}
              onPointerUp={clearLongPress}
              onPointerLeave={clearLongPress}
              onPointerCancel={clearLongPress}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
              }}
            >
              <img src={item.url} alt={item.caption || item.key} width={56} height={56} loading="lazy" />
            </button>
          ))}

          {canManage ? (
            <button
              type="button"
              className="pack-detail__add"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== ''}
              aria-label="添加表情"
            >
              <span aria-hidden="true">{busy === 'add' ? '··' : '＋'}</span>
              <span>添加</span>
            </button>
          ) : null}
        </div>

        {canManage ? (
          <label className="field pack-detail__emotion">
            <span className="field__label">新增表情的情绪（可选）</span>
            <select className="input" value={emotion} onChange={(event) => setEmotion(event.target.value)}>
              {EMOTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {canManage && pack.items.length === 0 ? (
          <p className="pack-detail__empty">还没有表情，点上面的「添加」选一张图。</p>
        ) : null}
      </div>

      <input
        ref={fileRef}
        className="composer__file"
        type="file"
        accept="image/*"
        onChange={handleFile}
        tabIndex={-1}
        aria-hidden="true"
      />

      {reportOpen ? (
        <ReportActionSheet
          title={`举报「${pack.title}」`}
          notify={notify}
          onClose={() => setReportOpen(false)}
          onSubmit={async (reason) => {
            try {
              await api.report({ targetType: 'sticker_pack', targetId: pack.id, reason })
              notify('已举报', 'success')
            } catch (err) {
              if (err instanceof ApiError && err.status === 409) {
                notify('你已举报过这个包', 'info')
                return
              }
              notify(err instanceof ApiError ? err.message : '举报失败，请重试', 'error')
            }
          }}
        />
      ) : null}
    </Modal>
  )
}
