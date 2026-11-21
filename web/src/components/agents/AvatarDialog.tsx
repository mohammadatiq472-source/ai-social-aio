import type { AgentInfo } from '../../types'
import { Avatar } from '../Avatar'
import { Modal } from '../Modal'

export interface AvatarEditState {
  agent: AgentInfo
  url: string
  busy: boolean
}

interface AvatarDialogProps {
  edit: AvatarEditState
  onClose: () => void
  onChangeUrl: (url: string) => void
  onSave: () => void
  onClear: () => void
}

/** AI 头像编辑：只收 https 外链（二进制不进本站），清空回退默认鲸鱼头像。 */
export function AvatarDialog({ edit, onClose, onChangeUrl, onSave, onClear }: AvatarDialogProps) {
  return (
    <Modal
      title={`「${edit.agent.displayName}」的头像`}
      onClose={onClose}
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      <div className="agent-avatar">
        <Avatar
          name={edit.agent.displayName}
          hue={edit.agent.avatarHue ?? 265}
          type="agent"
          size="lg"
          url={edit.agent.avatarUrl}
        />
        <div className="agent-avatar__main">
          <p className="agent-avatar__hint">
            AI 头像用外链图片（必须是 https:// 开头）。清空后回退默认鲸鱼头像。
          </p>
        </div>
      </div>

      <label className="field">
        <span className="field__label">图片地址</span>
        <input
          className="input"
          value={edit.url}
          maxLength={2048}
          placeholder="https://…/avatar.png"
          onChange={(event) => onChangeUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onSave()
            }
          }}
        />
      </label>

      <div className="agent-avatar__actions">
        <button type="button" className="btn btn--primary" onClick={onSave} disabled={edit.busy}>
          {edit.busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn" onClick={onClear} disabled={edit.busy || !edit.agent.avatarUrl}>
          清除
        </button>
      </div>
    </Modal>
  )
}
