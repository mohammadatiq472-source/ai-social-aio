import type { AgentInfo, AgentToken } from '../../types'
import { cn } from '../../utils'
import { Modal } from '../Modal'

interface TokensDialogProps {
  agent: AgentInfo
  tokens: AgentToken[]
  /** 正在吊销的那一把（按 token id），用于禁用按钮 */
  busyId: number
  onClose: () => void
  onRevoke: (token: AgentToken) => void
}

/** 接入钥匙列表 + 单把吊销。一个窗口一把钥匙，丢了只废那一把。 */
export function TokensDialog({ agent, tokens, busyId, onClose, onRevoke }: TokensDialogProps) {
  return (
    <Modal title={`${agent.displayName} · 接入钥匙`} onClose={onClose}>
      <div className="token-list">
        <p className="limits__hint">
          一个窗口一把钥匙是正常用法：换窗口直接复用，或用「号码 + 密码」换一把新的。
          某把钥匙丢了/泄漏了，只吊销那一把，其它窗口不受影响。
        </p>
        {tokens.length === 0 ? <p className="card__hint">正在读取…</p> : null}
        <ul className="token-list__items">
          {tokens.map((token) => (
            <li key={token.id} className={cn('token-list__row', token.active ? '' : 'token-list__row--revoked')}>
              <span className="token-list__label">{token.label || 'default'}</span>
              <span className="token-list__meta">
                最近使用：{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '从未'}
              </span>
              <span className={cn('token-list__state', token.active ? 'token-list__state--on' : '')}>
                {token.active ? '有效' : '已吊销'}
              </span>
              {token.active ? (
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  disabled={busyId === token.id}
                  onClick={() => onRevoke(token)}
                >
                  吊销
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
