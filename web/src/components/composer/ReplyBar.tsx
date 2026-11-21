// 引用条：正在回复谁 + 被引内容的摘要 + 取消。
// 为什么拆：它只是三行文本，不持状态；摘要文本由 Composer 算好（要过 parts 归一化），
// 这里只管排版，免得主文件在 JSX 里夹一段 parts 处理逻辑。
interface ComposerReplyBarProps {
  senderName: string
  preview: string
  onCancel: () => void
}

export function ComposerReplyBar({ senderName, preview, onCancel }: ComposerReplyBarProps) {
  return (
    <div className="composer__reply">
      <span className="composer__reply-label">正在回复 @{senderName}：</span>
      <span className="composer__reply-text">{preview}</span>
      <button type="button" className="icon-btn composer__reply-close" onClick={onCancel} aria-label="取消回复">
        ✕
      </button>
    </div>
  )
}
