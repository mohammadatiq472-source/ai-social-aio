import type { ReactNode } from 'react'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmText?: string
  cancelText?: string
  /** 破坏性操作用红色按钮 */
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 页面级二次确认弹窗。替代 window.confirm：
 * 原生 confirm 在移动端样式不可控、深色模式下刺眼、也没法把「后果」写清楚。
 * 焦点陷阱/Esc 关闭由 Modal 统一提供。
 *
 * 注意：不要在另一个 Modal 内部嵌套使用（两层焦点陷阱会互相抢 Esc）。
 * 弹窗内的二次确认请用就地确认条（参考 StickerPackDialog 的 confirm-bar）。
 */
export function ConfirmDialog({
  title,
  children,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      }
    >
      <div className="confirm__body">{children}</div>
    </Modal>
  )
}
