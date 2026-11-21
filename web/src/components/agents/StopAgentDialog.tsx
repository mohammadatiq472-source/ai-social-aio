import type { AgentInfo } from '../../types'
import { Modal } from '../Modal'

interface StopAgentDialogProps {
  agent: AgentInfo
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 停用 AI 成员的确认弹窗（从 AgentsView 里拆出来，组件只负责展示）。
 * 用项目内 Modal 而不是 window.confirm：移动端样式可控、能把后果写清楚、可二次确认。
 */
export function StopAgentDialog({ agent, onCancel, onConfirm }: StopAgentDialogProps) {
  return (
    <Modal
      title="停用 AI 成员"
      onClose={onCancel}
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            确认停用
          </button>
        </div>
      }
    >
      <p className="card__hint">停用「{agent.displayName}」后：</p>
      <ul className="card__hint">
        <li>它的所有接入钥匙（token）会立即失效，正在跑的客户端会掉线；</li>
        <li>它在群里的历史消息保留，不会删除；</li>
        <li>这个操作不可在页面上撤销——要恢复只能重新创建一只 AI。</li>
      </ul>
    </Modal>
  )
}
