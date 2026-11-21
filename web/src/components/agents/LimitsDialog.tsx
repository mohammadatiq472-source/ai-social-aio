import type { AgentInfo, AgentQuota } from '../../types'
import { Modal } from '../Modal'

export interface LimitsForm {
  daily: string
  capacity: string
  refill: string
}

interface LimitsDialogProps {
  agent: AgentInfo
  quota: AgentQuota | null
  form: LimitsForm
  busy: boolean
  onClose: () => void
  onFormChange: (patch: Partial<LimitsForm>) => void
  onSave: () => void
}

/**
 * 「发言额度」弹窗。表单状态与保存动作仍归父组件：保存成功要同步列表里的额度显示，
 * 状态提在父层比在每个弹窗里各存一份更省事。
 */
export function LimitsDialog({ agent, quota, form, busy, onClose, onFormChange, onSave }: LimitsDialogProps) {
  return (
    <Modal title={`${agent.displayName} · 发言额度`} onClose={onClose}>
      <div className="limits">
        <p className="limits__hint">
          上限归你调，平台只兜底防失控。改完立刻生效，Agent 下一次 <code>my_limits</code> /
          <code>send_message</code> 就能读到新值；刚调大的容量会把令牌桶灌满，不用等。
        </p>
        <label className="field">
          <span className="field__label">每日上限（条）</span>
          <input
            className="input"
            type="number"
            min={1}
            max={100000}
            value={form.daily}
            onChange={(event) => onFormChange({ daily: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field__label">突发容量（一次最多连发几条）</span>
          <input
            className="input"
            type="number"
            min={1}
            max={100}
            value={form.capacity}
            onChange={(event) => onFormChange({ capacity: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field__label">每分钟补充（条）</span>
          <input
            className="input"
            type="number"
            min={0}
            max={600}
            value={form.refill}
            onChange={(event) => onFormChange({ refill: event.target.value })}
          />
        </label>
        {quota ? (
          <p className="limits__quota">
            今日已用 {quota.used_today} / {quota.daily_limit}，剩余 {quota.remaining_today} 条
            {quota.paused ? ` · 当前已暂停（${quota.paused_reason ?? 'manual'}）` : ''}
          </p>
        ) : (
          <p className="limits__quota">正在读取额度…</p>
        )}
        <div className="limits__actions">
          <button type="button" className="btn" onClick={onSave} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
