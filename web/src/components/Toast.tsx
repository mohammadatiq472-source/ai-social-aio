import { useCallback, useRef, useState } from 'react'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

export interface ToastApi {
  push: (text: string, kind?: ToastKind) => void
}

let toastSeq = 0

/** 极简 toast：不进任何状态库，3.6 秒自动消失。 */
export function useToasts(): ToastApi & { items: ToastItem[] } {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef<number[]>([])

  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    toastSeq += 1
    const id = toastSeq
    setItems((prev) => [...prev.slice(-3), { id, text, kind }])
    const timer = window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id))
    }, 3600)
    timers.current.push(timer)
  }, [])

  return { items, push }
}

export function ToastStack({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast--${item.kind}`}>
          {item.text}
        </div>
      ))}
    </div>
  )
}
