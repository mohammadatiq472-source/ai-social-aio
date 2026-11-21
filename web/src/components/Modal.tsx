import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

/** 通用弹窗：点击遮罩 / Esc 关闭，打开时锁滚动；焦点关在弹窗内，关闭后还给触发按钮。 */
export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        ref={panelRef}
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  )
}
