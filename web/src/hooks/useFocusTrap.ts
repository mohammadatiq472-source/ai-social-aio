import { useEffect } from 'react'
import type { RefObject } from 'react'

/** 可聚焦元素选择器（够覆盖本项目的按钮/输入/链接；不用 :focusable 私有选择器） */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 弹窗焦点陷阱 + 焦点归还（WAI-ARIA APG 的 Dialog 模式）。
 *
 * 为什么需要：`aria-modal="true"` 只是告诉读屏「别管外面」，键盘 Tab 照样能跑出去；
 * 关闭后焦点落在 <body>，键盘用户要重新从页首 Tab 一遍（2026-11-14 前端审查 R4）。
 *
 * 实现取舍：
 * - 只拦 Tab / Shift+Tab + focusin 兜底，不用 `inert`（Safari 16 才稳，且会影响背景滚动）。
 * - 不拦 Esc：各弹窗自己的 Esc 语义不同（举报面板要先返回上一级），留给调用方。
 * - 打开时优先聚焦「容器自身」（tabIndex=-1），避免一进来就落在「关闭」按钮上被误触。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return
    const previous = document.activeElement as HTMLElement | null

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement)

    if (container.hasAttribute('tabindex')) container.focus()
    else (focusables()[0] ?? container).focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const list = focusables()
      if (!list.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const head = list[0]
      const tail = list[list.length - 1]
      const current = document.activeElement
      const inside = current != null && container.contains(current)
      if (event.shiftKey) {
        if (!inside || current === head) {
          event.preventDefault()
          tail.focus()
        }
      } else if (!inside || current === tail) {
        event.preventDefault()
        head.focus()
      }
    }

    // 兜底：脚本/浏览器把焦点移出容器时拉回来（不 preventDefault，避免打断输入法组字）
    const onFocusIn = (event: FocusEvent) => {
      if (container.contains(event.target as Node)) return
      const list = focusables()
      ;(list[0] ?? container).focus()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      // 归还焦点：触发元素可能已经被卸载（列表项被删），那就落回 body，别抛错
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [ref, active])
}
