import { useEffect, useRef, useState } from 'react'
import type { LocalMessage } from '../types'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { copyText } from '../utils'

interface MessageActionSheetProps {
  message: LocalMessage
  mine: boolean
  onClose: () => void
  onQuote: () => void
  onRecall: () => void
  onReport: (reason: string) => void | Promise<void>
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

const REPORT_REASONS = ['垃圾广告', '辱骂', '违法违规'] as const

type SheetMode = 'menu' | 'report' | 'custom'

/** 消息长按/右键动作面板（WeUI actionsheet 风格）：复制 / 引用 / 撤回 / 举报 / 取消 */
export function MessageActionSheet({ message, mine, onClose, onQuote, onRecall, onReport, notify }: MessageActionSheetProps) {
  const [mode, setMode] = useState<SheetMode>('menu')
  const [customReason, setCustomReason] = useState('')
  const [busy, setBusy] = useState(false)
  // 2 分钟撤回窗口：和服务端保持一致，过期就不显示「撤回」，别让用户点了才报错
  const RECALL_WINDOW_MS = 2 * 60 * 1000
  const createdMs = message.createdAt ? new Date(message.createdAt).getTime() : 0
  const withinRecallWindow = createdMs > 0 ? Date.now() - createdMs < RECALL_WINDOW_MS : false
  const canRecall = mine && message.seq != null && !message.recalledAt && withinRecallWindow
  const canReport = message.seq != null

  // 长按打开：手指抬起时浏览器会补一个 click，而那一刻遮罩刚出现，click 的目标就是遮罩，
  // 于是面板「闪一下就关」（手机上复制/引用/举报/撤回全点不到）。打开后 500ms 内忽略遮罩点击。
  // 面板内按钮有自己的 handler + stopPropagation，不受影响。
  const openedAtRef = useRef(Date.now())
  const maskClickGuard = () => {
    if (Date.now() - openedAtRef.current < 500) return
    onClose()
  }
  const panelRef = useRef<HTMLDivElement>(null)
  // 焦点关在面板内；关闭时还给原来那条消息的触发按钮
  useFocusTrap(panelRef)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (mode !== 'menu') {
        setMode('menu')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [mode, onClose])

  async function handleCopy() {
    const ok = await copyText(message.body ?? '')
    notify(ok ? '已复制' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error')
    onClose()
  }

  async function submitReport(reason: string) {
    const text = reason.trim()
    if (text.length < 2) {
      notify('请填写举报原因（至少 2 个字）', 'error')
      return
    }
    setBusy(true)
    try {
      await onReport(text)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ms-actions-mask" onClick={maskClickGuard}>
      <div
        ref={panelRef}
        className="ms-actions"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'menu' ? '消息操作' : '举报这条消息'}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {mode === 'menu' ? (
          <>
            <div className="ms-actions__group">
              <button type="button" className="ms-actions__item" aria-label="复制消息" onClick={() => void handleCopy()}>
                复制
              </button>
              <button
                type="button"
                className="ms-actions__item"
                aria-label="引用这条消息"
                onClick={() => {
                  onQuote()
                  onClose()
                }}
              >
                引用
              </button>
              {canRecall ? (
                <button
                  type="button"
                  className="ms-actions__item ms-actions__item--danger"
                  aria-label="撤回这条消息"
                  onClick={() => {
                    onRecall()
                    onClose()
                  }}
                >
                  撤回
                </button>
              ) : null}
              {canReport ? (
                <button type="button" className="ms-actions__item" aria-label="举报这条消息" onClick={() => setMode('report')}>
                  举报
                </button>
              ) : null}
            </div>
            <button type="button" className="ms-actions__cancel" aria-label="取消" onClick={onClose}>
              取消
            </button>
          </>
        ) : mode === 'report' ? (
          <>
            <div className="ms-actions__group">
              <p className="ms-actions__title">举报这条消息</p>
              {REPORT_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  className="ms-actions__item"
                  aria-label={`举报原因：${reason}`}
                  disabled={busy}
                  onClick={() => void submitReport(reason)}
                >
                  {reason}
                </button>
              ))}
              <button
                type="button"
                className="ms-actions__item"
                aria-label="举报原因：其他"
                disabled={busy}
                onClick={() => {
                  setCustomReason('')
                  setMode('custom')
                }}
              >
                其他
              </button>
            </div>
            <button type="button" className="ms-actions__cancel" aria-label="返回" disabled={busy} onClick={() => setMode('menu')}>
              返回
            </button>
          </>
        ) : (
          <>
            <div className="ms-actions__group ms-actions__custom">
              <p className="ms-actions__title">填写举报原因</p>
              <input
                className="input ms-actions__input"
                value={customReason}
                maxLength={200}
                autoFocus
                placeholder="至少 2 个字"
                aria-label="举报原因"
                disabled={busy}
                onChange={(event) => setCustomReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submitReport(customReason)
                  }
                }}
              />
              <button
                type="button"
                className="ms-actions__item ms-actions__item--primary"
                aria-label="提交举报"
                disabled={busy || customReason.trim().length < 2}
                onClick={() => void submitReport(customReason)}
              >
                {busy ? '提交中…' : '提交举报'}
              </button>
            </div>
            <button type="button" className="ms-actions__cancel" aria-label="返回" disabled={busy} onClick={() => setMode('report')}>
              返回
            </button>
          </>
        )}
      </div>
    </div>
  )
}
