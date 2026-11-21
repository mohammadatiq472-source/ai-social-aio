// 「＋」面板：相册 / 拍摄 / 语音 / 视频 / 表情。
// 只是展示与回调，具体动作由 Composer 决定（这里不碰上传/录音逻辑）。
import { CameraIcon, ImageIcon, MicIcon, SmileIcon, VideoIcon } from './icons'

interface PlusPanelProps {
  open: boolean
  disabled: boolean
  busy: boolean
  recording: boolean
  onGallery: () => void
  onCamera: () => void
  onVoice: () => void
  onVideo: () => void
  onStickers: () => void
}

export function ComposerPlusPanel({
  open,
  disabled,
  busy,
  recording,
  onGallery,
  onCamera,
  onVoice,
  onVideo,
  onStickers,
}: PlusPanelProps) {
  const itemDisabled = disabled || busy || recording
  return (
    <div className={`composer__panel${open ? ' composer__panel--open' : ''}`} aria-hidden={!open}>
      <div className="composer__panel-inner">
        <div className="composer__panel-grid" role="group" aria-label="更多功能">
          <button type="button" className="composer__panel-item" onClick={onGallery} disabled={itemDisabled}>
            <span className="composer__panel-icon" aria-hidden="true">
              {ImageIcon}
            </span>
            <span className="composer__panel-label">相册</span>
          </button>
          <button type="button" className="composer__panel-item" onClick={onCamera} disabled={itemDisabled}>
            <span className="composer__panel-icon" aria-hidden="true">
              {CameraIcon}
            </span>
            <span className="composer__panel-label">拍摄</span>
          </button>
          <button type="button" className="composer__panel-item" onClick={onVoice} disabled={itemDisabled}>
            <span className="composer__panel-icon" aria-hidden="true">
              {MicIcon}
            </span>
            <span className="composer__panel-label">语音</span>
          </button>
          <button type="button" className="composer__panel-item" onClick={onVideo} disabled={itemDisabled}>
            <span className="composer__panel-icon" aria-hidden="true">
              {VideoIcon}
            </span>
            <span className="composer__panel-label">视频</span>
          </button>
          <button type="button" className="composer__panel-item" onClick={onStickers} disabled={disabled || recording}>
            <span className="composer__panel-icon" aria-hidden="true">
              {SmileIcon}
            </span>
            <span className="composer__panel-label">表情</span>
          </button>
        </div>
      </div>
    </div>
  )
}
