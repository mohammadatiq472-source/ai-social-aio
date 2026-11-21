import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface ReportActionSheetProps {
  /** 标题，如「举报这条说说」 */
  title?: string
  onClose: () => void
  onSubmit: (reason: string) => void | Promise<void>
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

const REASONS = ['垃圾广告', '辱骂', '违法违规'] as const

/**
 * 通用举报原因面板（复用消息长按菜单的 WeUI actionsheet 视觉）。
 * 供说说 / 表情包等非消息对象使用；消息本身仍走 MessageActionSheet。
 */
export function ReportActionSheet({ title = '举报', onClose, onSubmit, notify }: ReportActionSheetProps) {
  const [mode, setMode] = useState<'list' | 'custom'>('list')
  const [customReason, setCustomReason] = useState('')
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 捕获阶段拦下：否则外层 Modal 的 Esc 会把整个弹窗一起关掉
      event.stopPropagation()
      event.preventDefault()
      if (mode === 'custom') {
        setMode('list')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previous
    }
  }, [mode, onClose])

  async function submit(reason: string) {
    const text = reason.trim()
    if (text.length < 2) {
      notify('请填写举报原因（至少 2 个字）', 'error')
      return
    }
    setBusy(true)
    try {
      await onSubmit(text)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ms-actions-mask" onClick={onClose}>
      <div
        ref={panelRef}
        className="ms-actions"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {mode === 'list' ? (
          <>
            <div className="ms-actions__group">
              <p className="ms-actions__title">{title}</p>
              {REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  className="ms-actions__item"
                  aria-label={`举报原因：${reason}`}
                  disabled={busy}
                  onClick={() => void submit(reason)}
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
            <button type="button" className="ms-actions__cancel" aria-label="取消" disabled={busy} onClick={onClose}>
              取消
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
                    void submit(customReason)
                  }
                }}
              />
              <button
                type="button"
                className="ms-actions__item ms-actions__item--primary"
                aria-label="提交举报"
                disabled={busy || customReason.trim().length < 2}
                onClick={() => void submit(customReason)}
              >
                {busy ? '提交中…' : '提交举报'}
              </button>
            </div>
            <button type="button" className="ms-actions__cancel" aria-label="返回" disabled={busy} onClick={() => setMode('list')}>
              返回
            </button>
          </>
        )}
      </div>
    </div>
  )
}
