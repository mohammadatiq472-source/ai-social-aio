// 待发媒体的三张卡片：图片（上传中/失败可重试）、视频（抽封面/进度条/失败原因）、语音（时长/大小/重发）。
// 为什么拆：三段卡片结构重复、各自带 aria（role=progressbar / role=status），
// 而且它们只在「有 pending 时」出现，和输入框无关；搬出去后主文件只留一份 <ComposerUploadPreviews .../>。
// 这里不持有任何状态：上传时序、取消、重试都在 useVideoMessage / useVoiceRecorder / Composer 里，
// 所以 props 直接沿用那几个 hook 的既有形状（只声明用到的字段），避免在多处再映射一遍。
import { formatRecordTime } from '../../lib/voice'
import { cn } from '../../utils'
import { MicIcon } from './icons'

/** 与 Composer 的 PendingUpload 同形：只读 status 判断在传/失败 */
interface PendingImageLike {
  file: File
  localUrl: string
  status: 'uploading' | 'failed'
}

/** 与 useVideoMessage 的 PendingVideo 同形 */
interface PendingVideoLike {
  file: File
  status: 'poster' | 'uploading' | 'failed'
  progress: number
  error?: string
}

/** 与 useVoiceRecorder 的 PendingVoice 同形 */
interface PendingVoiceLike {
  blob: Blob
  durationMs: number
  status: 'uploading' | 'failed'
}

interface ComposerUploadPreviewsProps {
  image: PendingImageLike | null
  video: PendingVideoLike | null
  voice: PendingVoiceLike | null
  /** 图片重试要拿回文件本身，由 Composer 决定走哪套校验/上传 */
  onRetryImage: (file: File) => void
  onCancelImage: () => void
  onRetryVideo: () => void
  onCancelVideo: () => void
  onRetryVoice: () => void
  onCancelVoice: () => void
}

export function ComposerUploadPreviews({
  image,
  video,
  voice,
  onRetryImage,
  onCancelImage,
  onRetryVideo,
  onCancelVideo,
  onRetryVoice,
  onCancelVoice,
}: ComposerUploadPreviewsProps) {
  const uploading = image?.status === 'uploading'
  const voiceUploading = voice?.status === 'uploading'
  return (
    <>
      {image ? (
        <div className="composer__upload">
          <span className="composer__upload-thumb">
            <img src={image.localUrl} alt="待发送图片预览" />
          </span>
          <div className="composer__upload-meta">
            <span className="composer__upload-title">{uploading ? '正在上传图片…' : '图片上传失败'}</span>
            <span className="composer__upload-name" title={image.file.name}>
              {image.file.name}
            </span>
          </div>
          <div className="composer__upload-actions">
            {uploading ? (
              <span className="composer__upload-spinner" role="status" aria-label="上传中" />
            ) : (
              <button
                type="button"
                className="btn btn--sm btn--primary composer__upload-btn"
                onClick={() => onRetryImage(image.file)}
              >
                重试
              </button>
            )}
            <button type="button" className="icon-btn composer__upload-cancel" onClick={onCancelImage} aria-label="取消上传">
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {video ? (
        <div className={cn('composer__upload', 'composer__upload--video', video.status === 'failed' && 'composer__upload--failed')}>
          <span className="composer__upload-thumb composer__upload-thumb--video" aria-hidden="true">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 6.5h11.2c.8 0 1.4.6 1.4 1.4v8.2c0 .8-.6 1.4-1.4 1.4H4c-.8 0-1.4-.6-1.4-1.4V7.9c0-.8.6-1.4 1.4-1.4Zm14.1 2.9 3.6-2.1v9.4l-3.6-2.1V9.4Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <div className="composer__upload-meta">
            <span className="composer__upload-title">
              {video.status === 'poster'
                ? '正在读取视频信息…'
                : video.status === 'failed'
                  ? '视频上传失败'
                  : `正在上传视频… ${video.progress}%`}
            </span>
            <span className="composer__upload-name" title={video.file.name}>
              {video.file.name}
            </span>
            {video.status === 'uploading' ? (
              <span
                className="composer__progress"
                role="progressbar"
                aria-label="视频上传进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={video.progress}
              >
                <span className="composer__progress-fill" style={{ width: `${video.progress}%` }} />
              </span>
            ) : null}
            {video.status === 'failed' && video.error ? <span className="composer__upload-error">{video.error}</span> : null}
          </div>
          <div className="composer__upload-actions">
            {video.status === 'failed' ? (
              <button type="button" className="btn btn--sm btn--primary composer__upload-btn" onClick={onRetryVideo}>
                重试
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn composer__upload-cancel"
              onClick={onCancelVideo}
              aria-label={video.status === 'failed' ? '放弃这个视频' : '取消上传'}
              title={video.status === 'failed' ? '放弃这个视频' : '取消上传'}
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {voice ? (
        <div className="composer__upload composer__upload--voice">
          <span className="composer__upload-thumb composer__upload-thumb--voice" aria-hidden="true">
            {MicIcon}
          </span>
          <div className="composer__upload-meta">
            <span className="composer__upload-title">{voiceUploading ? '正在发送语音…' : '语音发送失败'}</span>
            <span className="composer__upload-name">
              时长 {formatRecordTime(voice.durationMs)} · {Math.max(1, Math.round(voice.blob.size / 1024))} KB
            </span>
          </div>
          <div className="composer__upload-actions">
            {voiceUploading ? (
              <span className="composer__upload-spinner" role="status" aria-label="上传中" />
            ) : (
              <button type="button" className="btn btn--sm btn--primary composer__upload-btn" onClick={onRetryVoice}>
                重发
              </button>
            )}
            <button type="button" className="icon-btn composer__upload-cancel" onClick={onCancelVoice} aria-label="取消发送语音">
              ✕
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
