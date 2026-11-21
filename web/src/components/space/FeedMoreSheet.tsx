import { useEffect, useRef } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { LocalFeed } from './types'

interface FeedMoreSheetProps {
  /** null = 关闭；否则显示这条说说的操作菜单 */
  feed: LocalFeed | null
  onClose: () => void
  onReport: (feed: LocalFeed) => void
}

/**
 * 说说右上角「⋯」的操作菜单（自建 dialog：Esc 关闭 + 焦点陷阱/归还，与 Modal 行为对齐）。
 *
 * 为什么拆：焦点陷阱与 Esc 监听只属于这个浮层，跟列表数据无关；
 * 主视图只保留「当前打开的是哪条」一个状态，避免 ref/effect 混在数据逻辑里。
 */
export function FeedMoreSheet({ feed, onClose, onReport }: FeedMoreSheetProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useFocusTrap(menuRef, feed != null)

  useEffect(() => {
    if (!feed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [feed, onClose])

  if (!feed) return null

  return (
    <div className="ms-actions-mask" onClick={onClose}>
      <div
        ref={menuRef}
        className="ms-actions"
        role="dialog"
        aria-modal="true"
        aria-label="说说操作"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ms-actions__group">
          <button
            type="button"
            className="ms-actions__item"
            aria-label="举报这条说说"
            onClick={() => onReport(feed)}
          >
            举报
          </button>
        </div>
        <button type="button" className="ms-actions__cancel" aria-label="取消" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  )
}
