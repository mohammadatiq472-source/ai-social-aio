import type { AgentInfo, AgentMembership, ReplyMode } from '../../types'
import { REPLY_MODE_TEXT } from '../../utils'
import { Modal } from '../Modal'

/** 「它加入了哪些群」弹窗的聚合状态（loading/rows 由父组件拉取） */
export interface MembershipState {
  agent: AgentInfo
  rows: AgentMembership[]
  loading: boolean
}

interface MembershipsDialogProps {
  membership: MembershipState
  onClose: () => void
  onUpdate: (row: AgentMembership, patch: { replyMode?: ReplyMode; allowAiRelay?: boolean }) => void
}

/** 群内档位只有这四档（mention/free 是 agent 自己的模式，不是档位） */
const MODE_OPTIONS: ReplyMode[] = ['off', 'low', 'mid', 'high']

/** 「这只 AI 在哪些群、各自接不接话」：群档位在这里调，改完立即生效。 */
export function MembershipsDialog({ membership, onClose, onUpdate }: MembershipsDialogProps) {
  return (
    <Modal
      title={`「${membership.agent.displayName}」的群`}
      onClose={onClose}
      wide
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      {membership.loading ? <p className="card__hint">正在读取…</p> : null}
      {!membership.loading && membership.rows.length === 0 ? (
        <p className="agent-membership__empty">它还没加入任何群</p>
      ) : null}

      {membership.rows.length > 0 ? (
        <ul className="agent-membership-list">
          {membership.rows.map((row) => (
            <li key={row.conversationId} className="agent-membership">
              <span className="agent-membership__main">
                <span className="agent-membership__title">{row.title || '未命名群'}</span>
                <span className="agent-membership__meta">{row.memberCount} 人</span>
              </span>
              <select
                className="agent-membership__select"
                value={row.replyMode}
                aria-label={`${row.title || '群'} 的发言档位`}
                onChange={(event) => onUpdate(row, { replyMode: event.target.value as ReplyMode })}
              >
                {MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {REPLY_MODE_TEXT[mode] ?? mode}
                  </option>
                ))}
              </select>
              <label className="agent-membership__relay">
                <input
                  type="checkbox"
                  checked={row.allowAiRelay === true}
                  onChange={(event) => onUpdate(row, { allowAiRelay: event.target.checked })}
                />
                接 AI 的话
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  )
}
