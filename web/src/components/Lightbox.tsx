import { useEffect, useRef } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface LightboxProps {
  url: string
  alt?: string
  onClose: () => void
}

/** 全屏灯箱：黑底、点空白关闭、Esc 关闭、点图片本身不关闭 */
export function Lightbox({ url, alt, onClose }: LightboxProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  useFocusTrap(boxRef)

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
    <div ref={boxRef} className="lightbox" role="dialog" aria-modal="true" aria-label="查看大图" tabIndex={-1} onClick={onClose}>
      <button type="button" className="lightbox__close" onClick={onClose} aria-label="关闭">
        ✕
      </button>
      <img
        className="lightbox__img"
        src={url}
        alt={alt ?? '图片'}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  )
}
