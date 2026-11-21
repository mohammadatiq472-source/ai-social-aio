// 输入行：录音中就显示录音条（计时/上滑取消/✕），否则显示输入框。
// 为什么拆：这两块是同一个位置上的二选一，原来和「＋ / 工具按钮 / 发送」混在一段 JSX 里，
// 看不出它们是互斥的。录音态的手势与计时仍来自 useVoiceRecorder，这里只负责画。
import type {
  ChangeEventHandler,
  KeyboardEventHandler,
  ClipboardEventHandler,
  FocusEventHandler,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from 'react'
import { cn } from '../../utils'
import { formatRecordTime } from '../../lib/voice'

/** 与 useVoiceRecorder 的 RecordingState 同形：只用到这两个字段 */
interface RecordingLike {
  elapsedMs: number
  cancelArmed: boolean
}

interface ComposerInputRowProps {
  recording: RecordingLike | null
  inputRef: RefObject<HTMLTextAreaElement | null>
  text: string
  disabled?: boolean
  maxLength: number
  onChange: ChangeEventHandler<HTMLTextAreaElement>
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>
  onFocus: FocusEventHandler<HTMLTextAreaElement>
  onRecTouchStart: (event: ReactTouchEvent<HTMLDivElement>) => void
  onRecTouchMove: (event: ReactTouchEvent<HTMLDivElement>) => void
  onRecTouchEnd: () => void
  onCancelRecording: () => void
}

export function ComposerInputRow({
  recording,
  inputRef,
  text,
  disabled,
  maxLength,
  onChange,
  onKeyDown,
  onPaste,
  onFocus,
  onRecTouchStart,
  onRecTouchMove,
  onRecTouchEnd,
  onCancelRecording,
}: ComposerInputRowProps) {
  if (recording) {
    return (
      <div
        className={cn('composer__rec', recording.cancelArmed && 'is-cancel')}
        onTouchStart={onRecTouchStart}
        onTouchMove={onRecTouchMove}
        onTouchEnd={onRecTouchEnd}
        onTouchCancel={onRecTouchEnd}
        role="status"
        aria-live="polite"
      >
        <span className="composer__rec-dot" aria-hidden="true" />
        <span className="composer__rec-time">{formatRecordTime(recording.elapsedMs)}</span>
        <span className="composer__rec-hint">{recording.cancelArmed ? '松开取消' : '上滑取消'}</span>
        <button
          type="button"
          className="composer__rec-cancel"
          onClick={onCancelRecording}
          aria-label="取消录音"
          title="取消录音"
        >
          ✕
        </button>
      </div>
    )
  }

  return (
    <textarea
      ref={inputRef}
      className="composer__input"
      value={text}
      rows={1}
      maxLength={maxLength}
      enterKeyHint="send"
      autoComplete="off"
      onChange={onChange}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      placeholder={disabled ? '你已被移出该会话' : '发消息，@ 点名'}
      disabled={disabled}
      aria-label="消息输入框"
    />
  )
}
