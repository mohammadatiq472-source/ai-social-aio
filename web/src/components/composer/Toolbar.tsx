// 输入栏这一排：＋（手机端）/ 图片 / 表情 / 录音 / 字数 / 发送。
// 为什么拆：这一排全是「按钮 + 回调」，状态和时序（上传中、录音中、能不能发）都在 Composer 里算好传进来；
// 拆出来以后主文件的 JSX 只剩排版分发，按钮的 disabled/aria 规则也只在这一处。
// 中间那块输入区（输入框或录音条）由 Composer 通过 children 塞进来：
// 它俩是二选一，只有 Composer 知道当前该渲染哪个。
import type { ReactNode } from 'react'
import { cn } from '../../utils'
import { MAX_LENGTH } from './input-helpers'
import { ImageIcon, KeyboardIcon, MicIcon, PlusIcon, SmileIcon } from './icons'

/** 超过这个字数才显示计数（免得太早闪烁） */
const COUNTER_WARN_AT = 3500

const SendIcon = (
  <svg
    className="composer__send-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    aria-hidden="true"
  >
    <path d="M20.4 3.6 3 10.3l7 2.9 2.9 7 7.5-16.6Z" strokeLinejoin="round" />
    <path d="m10 13.2 4.4-4.4" strokeLinecap="round" />
  </svg>
)

interface ComposerToolbarProps {
  plusOpen: boolean
  stickerOpen: boolean
  /** 录音中：隐藏输入框、锁住发送这类由 Composer 判断的状态 */
  recording: boolean
  disabled: boolean
  /** 有上传在途（图片/语音） */
  busy: boolean
  /** 只有字数与「能否发送」用到正文 */
  text: string
  onTogglePlus: () => void
  onPickImage: () => void
  onToggleSticker: () => void
  onToggleMic: () => void
  onSend: () => void
  children: ReactNode
}

export function ComposerToolbar({
  plusOpen,
  stickerOpen,
  recording,
  disabled,
  busy,
  text,
  onTogglePlus,
  onPickImage,
  onToggleSticker,
  onToggleMic,
  onSend,
  children,
}: ComposerToolbarProps) {
  return (
    <div className="composer__box">
      <button
        type="button"
        className={cn('icon-btn composer__plus', plusOpen && 'is-open')}
        onClick={onTogglePlus}
        disabled={disabled || recording}
        aria-label={plusOpen ? '收起面板，回到键盘' : '更多功能：相册、拍摄、语音、表情'}
        aria-expanded={plusOpen}
        title={plusOpen ? '收起面板' : '更多功能'}
      >
        {plusOpen ? KeyboardIcon : PlusIcon}
      </button>

      <div className="composer__tools">
        <button
          type="button"
          className="icon-btn composer__tool composer__tool--image"
          onClick={onPickImage}
          disabled={disabled || busy || recording}
          aria-label="发送图片"
          title="发送图片（也可粘贴或拖入）"
        >
          {ImageIcon}
        </button>
        <button
          type="button"
          className={cn('icon-btn composer__tool composer__tool--sticker', stickerOpen && 'is-active')}
          onClick={onToggleSticker}
          disabled={disabled || recording}
          aria-label="表情"
          aria-expanded={stickerOpen}
          title="表情"
        >
          {SmileIcon}
        </button>
        <button
          type="button"
          className={cn('icon-btn composer__tool composer__tool--mic', recording && 'is-recording')}
          onClick={onToggleMic}
          disabled={disabled || busy}
          aria-label={recording ? '结束录音并发送' : '录制语音'}
          aria-pressed={recording}
          title={recording ? '结束录音并发送（60 秒自动停）' : '录制语音（最长 60 秒）'}
        >
          {MicIcon}
        </button>
      </div>

      {children}

      <div className="composer__side">
        <span className={cn('composer__counter', text.length > COUNTER_WARN_AT && 'composer__counter--warn')}>
          {text.length > COUNTER_WARN_AT ? `${text.length}/${MAX_LENGTH}` : ''}
        </span>
        <button
          type="button"
          className="btn btn--primary composer__send"
          onClick={onSend}
          disabled={disabled || !text.trim() || busy || recording}
          aria-label="发送"
          title="发送（Enter）"
        >
          {SendIcon}
          <span className="composer__send-text">发送</span>
        </button>
      </div>
    </div>
  )
}
