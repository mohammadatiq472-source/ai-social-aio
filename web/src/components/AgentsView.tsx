import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { AgentInfo, AgentMembership, AgentQuota, AgentToken, ReplyMode } from '../types'
import { AGENT_STATUS_TEXT, cn } from '../utils'
import { Avatar } from './Avatar'
import { AvatarDialog } from './agents/AvatarDialog'
import type { AvatarEditState } from './agents/AvatarDialog'
import { ConfigDialog } from './agents/ConfigDialog'
import type { ConfigDetail } from './agents/ConfigDialog'
import { LimitsDialog } from './agents/LimitsDialog'
import type { LimitsForm } from './agents/LimitsDialog'
import { MembershipsDialog } from './agents/MembershipsDialog'
import type { MembershipState } from './agents/MembershipsDialog'
import { StopAgentDialog } from './agents/StopAgentDialog'
import { TokensDialog } from './agents/TokensDialog'

interface AgentsViewProps {
  onBack: () => void
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

/** /api/agents 旧版本不带 accountNo：把创建时拿到的号码缓存下来，刷新后卡片也能显示 */
const ACCOUNT_CACHE_KEY = 'qqmini:agent-accounts'

function readAccountCache(): Record<number, number> {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_CACHE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed == null || typeof parsed !== 'object') return {}
    const out: Record<number, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key)
      if (Number.isInteger(id) && typeof value === 'number') out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeAccountCache(map: Record<number, number>): void {
  try {
    window.localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(map))
  } catch {
    /* 隐私模式写不进去就算了，不影响主流程 */
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

export function AgentsView({ onBack, notify }: AgentsViewProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ConfigDetail | null>(null)
  const [accountCache, setAccountCache] = useState<Record<number, number>>(() => readAccountCache())
  // 「它加入了哪些群」：每群的档位/relay 在主人这里改
  const [membership, setMembership] = useState<MembershipState | null>(null)
  // 发言额度弹窗（门控改造：上限归主人，改完立刻生效；Agent 侧 my_limits 能读到）
  const [limitsFor, setLimitsFor] = useState<AgentInfo | null>(null)
  const [quota, setQuota] = useState<AgentQuota | null>(null)
  const [limitsForm, setLimitsForm] = useState<LimitsForm>({ daily: '', capacity: '', refill: '' })
  const [limitsBusy, setLimitsBusy] = useState(false)
  // 接入钥匙：一个窗口一把；丢了只废那一把
  const [tokensFor, setTokensFor] = useState<AgentInfo | null>(null)
  const [tokens, setTokens] = useState<AgentToken[]>([])
  const [tokenBusy, setTokenBusy] = useState(0)
  // 头像编辑弹窗：AI 只收 https 外链（二进制不进本站）
  const [avatarEdit, setAvatarEdit] = useState<AvatarEditState | null>(null)
  // 主人开关（主动私聊 / 自己退群 / 进入 3D 空间）：`${agentId}:${kind}`，同一时刻只让一个开关在飞
  const [switchBusy, setSwitchBusy] = useState<string | null>(null)
  // 3D 空间入口：只有服务端配了 WORLD_PUBLIC_URL + 票据密钥才显示
  const [world, setWorld] = useState<{ enabled: boolean; url: string | null } | null>(null)
  const [worldBusy, setWorldBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void api.worldStatus()
      .then((s) => { if (alive) setWorld(s) })
      .catch(() => { if (alive) setWorld({ enabled: false, url: null }) })
    return () => { alive = false }
  }, [])

  /** 进入 3D 空间：先换一次性票据，再新标签打开（不把 sid 带进 world 域） */
  async function enterWorld() {
    if (worldBusy) return
    setWorldBusy(true)
    try {
      const { url } = await api.worldTicket()
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '进空间失败，请稍后再试', 'error')
    } finally {
      setWorldBusy(false)
    }
  }

  function rememberAccount(id: number, accountNo: number | null | undefined) {
    if (accountNo == null) return
    setAccountCache((prev) => {
      if (prev[id] === accountNo) return prev
      const next = { ...prev, [id]: accountNo }
      writeAccountCache(next)
      return next
    })
  }

  const reload = useCallback(async () => {
    try {
      const list = await api.agents()
      setAgents(list)
      // 列表里如果带了号码，顺手补进缓存
      const known = list.filter((agent) => agent.accountNo != null)
      if (known.length > 0) {
        setAccountCache((prev) => {
          let changed = false
          const next = { ...prev }
          for (const agent of known) {
            if (typeof agent.accountNo === 'number' && next[agent.id] !== agent.accountNo) {
              next[agent.id] = agent.accountNo
              changed = true
            }
          }
          if (changed) writeAccountCache(next)
          return changed ? next : prev
        })
      }
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'unauthorized') setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function createAgent() {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 40) {
      setError('AI 名称需要 1–40 个字符')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await api.createAgent({ displayName: trimmed })
      setName('')
      const accountNo = res.agent.accountNo ?? res.login?.accountNo ?? null
      rememberAccount(res.agent.id, accountNo)
      setDetail({
        kind: 'created',
        name: res.agent.displayName,
        token: res.token,
        accountNo,
        password: res.login?.password ?? null,
        config: null,
        loading: true,
      })
      void api
        .agentConfig(res.agent.id)
        .then((config) => {
          setDetail((prev) => (prev && prev.kind === 'created' ? { ...prev, config, loading: false } : prev))
        })
        .catch(() => {
          setDetail((prev) => (prev && prev.kind === 'created' ? { ...prev, loading: false } : prev))
        })
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function openConfig(agent: AgentInfo) {
    setDetail({ kind: 'config', name: agent.displayName, token: null, config: null, loading: true })
    try {
      const config = await api.agentConfig(agent.id)
      setDetail((prev) => (prev && prev.kind === 'config' ? { ...prev, config, loading: false } : prev))
    } catch (err) {
      setDetail((prev) => (prev && prev.kind === 'config' ? { ...prev, loading: false } : prev))
      notify(err instanceof ApiError ? err.message : '配置读取失败', 'error')
    }
  }

  async function openMemberships(agent: AgentInfo) {
    setMembership({ agent, rows: [], loading: true })
    try {
      const rows = await api.agentMemberships(agent.id)
      setMembership((prev) => (prev && prev.agent.id === agent.id ? { ...prev, rows, loading: false } : prev))
    } catch (err) {
      setMembership((prev) => (prev ? { ...prev, loading: false } : prev))
      notify(err instanceof ApiError ? err.message : '读取群设置失败', 'error')
    }
  }

  /** 改某个群里这只 AI 的档位/relay：乐观更新，失败回滚 */
  async function updateMembership(row: AgentMembership, patch: { replyMode?: ReplyMode; allowAiRelay?: boolean }) {
    const current = membership
    if (!current) return
    const nextMode = patch.replyMode ?? row.replyMode
    const nextRelay = patch.allowAiRelay ?? row.allowAiRelay
    const apply = (replyMode: ReplyMode, allowAiRelay: boolean) =>
      setMembership((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((item) =>
                item.conversationId === row.conversationId ? { ...item, replyMode, allowAiRelay } : item,
              ),
            }
          : prev,
      )
    apply(nextMode, nextRelay)
    try {
      await api.setReplyMode(row.conversationId, current.agent.id, nextMode, nextRelay)
      notify('已更新群内设置', 'success')
    } catch (err) {
      apply(row.replyMode, row.allowAiRelay)
      notify(err instanceof ApiError ? err.message : '修改失败，请重试', 'error')
    }
  }

  async function openTokens(agent: AgentInfo) {
    setTokensFor(agent)
    setTokens([])
    try {
      setTokens(await api.agentTokens(agent.id))
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '钥匙读取失败', 'error')
    }
  }

  async function revokeToken(token: AgentToken) {
    if (!tokensFor || tokenBusy) return
    setTokenBusy(token.id)
    try {
      await api.revokeAgentToken(tokensFor.id, token.id)
      setTokens(await api.agentTokens(tokensFor.id))
      notify('已吊销这把钥匙（其它窗口不受影响）', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '吊销失败', 'error')
    } finally {
      setTokenBusy(0)
    }
  }

  async function openLimits(agent: AgentInfo) {
    setLimitsFor(agent)
    setQuota(null)
    setLimitsForm({
      daily: String(agent.dailyLimit ?? 1000),
      capacity: String(agent.bucketCapacity ?? 5),
      refill: String(agent.bucketRefillPerMin ?? 10),
    })
    try {
      setQuota(await api.agentLimits(agent.id))
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '额度读取失败', 'error')
    }
  }

  async function saveLimits() {
    if (!limitsFor || limitsBusy) return
    setLimitsBusy(true)
    try {
      const res = await api.setAgentLimits(limitsFor.id, {
        dailyLimit: Number(limitsForm.daily),
        bucketCapacity: Number(limitsForm.capacity),
        bucketRefillPerMin: Number(limitsForm.refill),
      })
      setQuota(res.quota)
      setAgents((prev) =>
        prev.map((item) =>
          item.id === limitsFor.id
            ? {
                ...item,
                dailyLimit: res.quota.daily_limit,
                bucketCapacity: res.quota.bucket_capacity,
                bucketRefillPerMin: res.quota.bucket_refill_per_min,
              }
            : item,
        ),
      )
      notify('额度已更新，Agent 下一次调用就能读到', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '保存失败，请重试', 'error')
    } finally {
      setLimitsBusy(false)
    }
  }

  // 主人开关：点一下立刻生效（不弹窗、不二次确认——这是可随时改回来的权限，不是危险操作）
  async function toggleSwitch(agent: AgentInfo, kind: 'dm' | 'leave' | 'world') {
    const key = `${agent.id}:${kind}`
    if (switchBusy) return
    setSwitchBusy(key)
    const next = kind === 'dm' ? !agent.canInitiateDm : kind === 'leave' ? !agent.canLeaveGroup : !agent.canEnterWorld
    try {
      if (kind === 'dm') await api.setAgentDm(agent.id, next)
      else if (kind === 'leave') await api.setAgentLeave(agent.id, next)
      else await api.setAgentWorld(agent.id, next)
      notify(
        kind === 'dm'
          ? (next ? '已允许它主动私聊同群的人' : '已关闭：同群不再主动私聊（主人/好友仍可）')
          : kind === 'leave'
            ? (next ? '已允许它自己退群' : '已关闭自己退群')
            : (next ? '已允许它进入 3D 空间' : '已关闭：world_* 工具会被拒绝'),
        'success',
      )
      await reload()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '开关保存失败', 'error')
    } finally {
      setSwitchBusy(null)
    }
  }

  async function togglePause(agent: AgentInfo) {    const paused = agent.status !== 'paused'
    try {
      await api.pauseAgent(agent.id, paused)
      notify(paused ? '已暂停该 AI 的发言' : '已恢复该 AI 的发言', 'success')
      await reload()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败', 'error')
    }
  }

  // 停用确认：用项目内 Modal 而不是 window.confirm（移动端样式不可控、没法写后果说明）
  const [stopTarget, setStopTarget] = useState<AgentInfo | null>(null)

  async function removeAgent(agent: AgentInfo) {
    try {
      await api.deleteAgent(agent.id)
      notify('已停用并吊销 token', 'success')
      setStopTarget(null)
      await reload()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '停用失败', 'error')
    }
  }

  /** 打开头像编辑：只有外链才回填（本站附件地址带短期签名，不让用户改） */
  function openAvatar(agent: AgentInfo) {
    const external = typeof agent.avatarUrl === 'string' && /^https:\/\//i.test(agent.avatarUrl) ? agent.avatarUrl : ''
    setAvatarEdit({ agent, url: external, busy: false })
  }

  /** 用接口返回的 agent 就地刷新列表和弹窗（避免整页重新拉取） */
  function applyAgent(agent: AgentInfo) {
    setAgents((prev) => prev.map((item) => (item.id === agent.id ? { ...item, ...agent } : item)))
    setAvatarEdit((prev) => (prev && prev.agent.id === agent.id ? { ...prev, agent } : prev))
  }

  async function saveAgentAvatar() {
    const current = avatarEdit
    if (!current || current.busy) return
    const url = current.url.trim()
    if (!url) {
      notify('请填写图片地址', 'error')
      return
    }
    // 契约 §1.2：只收 https（禁 javascript:/data:/file:），长度 ≤2048
    if (!/^https:\/\//i.test(url)) {
      notify('头像地址必须以 https:// 开头', 'error')
      return
    }
    if (url.length > 2048) {
      notify('头像地址太长（最多 2048 个字符）', 'error')
      return
    }
    setAvatarEdit({ ...current, busy: true })
    try {
      const res = await api.setAgentAvatar(current.agent.id, url)
      applyAgent(res.agent)
      notify('头像已更新', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '保存失败，请重试', 'error')
    } finally {
      setAvatarEdit((prev) => (prev && prev.agent.id === current.agent.id ? { ...prev, busy: false } : prev))
    }
  }

  async function clearAgentAvatar() {
    const current = avatarEdit
    if (!current || current.busy) return
    setAvatarEdit({ ...current, busy: true })
    try {
      const res = await api.clearAgentAvatar(current.agent.id)
      applyAgent(res.agent)
      setAvatarEdit((prev) => (prev && prev.agent.id === current.agent.id ? { ...prev, url: '' } : prev))
      notify('已恢复默认头像', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '清除失败，请重试', 'error')
    } finally {
      setAvatarEdit((prev) => (prev && prev.agent.id === current.agent.id ? { ...prev, busy: false } : prev))
    }
  }

  async function handleCopy(text: string, label: string) {
    const ok = await copyText(text)
    notify(ok ? `${label} 已复制` : '复制失败，请手动选择文本复制', ok ? 'success' : 'error')
  }

  return (
    <div className="agents">
      <header className="agents__head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回聊天">
          ←
        </button>
        <div>
          <h1 className="agents__title">AI 成员管理</h1>
        </div>
        <button type="button" className="btn" onClick={() => void reload()}>
          刷新
        </button>
        {world?.enabled ? (
          <button type="button" className="btn btn--primary" onClick={() => void enterWorld()} disabled={worldBusy}>
            {worldBusy ? '准备中…' : '进入 3D 空间'}
          </button>
        ) : null}
      </header>

      <div className="agents__grid">
        <section className="card">
          <h2 className="card__title">我的 AI（{agents.length}）</h2>
          {loading ? <p className="card__hint">正在加载…</p> : null}
          {!loading && agents.length === 0 ? <p className="card__hint">还没有创建 AI 成员</p> : null}

          <ul className="agent-list">
            {agents.map((agent) => (
              <li key={agent.id} className="agent-row">
                <Avatar name={agent.displayName} hue={agent.avatarHue ?? 265} type="agent" size="md" url={agent.avatarUrl} />
                <div className="agent-row__main">
                  <div className="agent-row__head">
                    <span className="agent-row__name">{agent.displayName}</span>
                    <span className={cn('status-pill', `status-pill--${agent.status}`)}>
                      {AGENT_STATUS_TEXT[agent.status] ?? agent.status}
                    </span>
                  </div>
                  <p className="agent-row__meta">
                    号码 {agent.accountNo ?? accountCache[agent.id] ?? '—'}
                    {agent.dailyLimit != null ? ` · 日限 ${agent.dailyLimit} 条` : ''}
                    {agent.bucketCapacity != null ? ` · 桶 ${agent.bucketCapacity}/${agent.bucketRefillPerMin}每分钟` : ''}
                  </p>
                  {agent.status === 'paused' && agent.pausedReason ? (
                    <p className="agent-row__meta agent-row__meta--warn">
                      {agent.pausedReason === 'circuit_breaker'
                        ? '被自动暂停：疑似 AI 之间互相接力（防死循环）。确认没问题可点「恢复」。'
                        : '已被主人暂停'}
                    </p>
                  ) : null}
                  <div className="agent-row__switches">
                    <div className="agent-row__switch">
                      <span className="agent-row__switch-text">
                        主动私聊
                        <small>{agent.canInitiateDm ? '已允许：它可以主动私聊「同群但还不是好友」的人（主人和好友一直允许）' : '已关闭：同群的人只能等它先被对方接受，主人/好友不受影响'}</small>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={agent.canInitiateDm === true}
                        aria-label="允许主动私聊"
                        className={cn('switch', agent.canInitiateDm && 'switch--on')}
                        disabled={switchBusy !== null}
                        onClick={() => void toggleSwitch(agent, 'dm')}
                      >
                        <span className="switch__knob" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="agent-row__switch">
                      <span className="agent-row__switch-text">
                        自己退群
                        <small>{agent.canLeaveGroup ? '已允许：它可以自己退出某个群' : '已关闭：需要你或群主把它移出'}</small>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={agent.canLeaveGroup === true}
                        aria-label="允许自己退群"
                        className={cn('switch', agent.canLeaveGroup && 'switch--on')}
                        disabled={switchBusy !== null}
                        onClick={() => void toggleSwitch(agent, 'leave')}
                      >
                        <span className="switch__knob" aria-hidden="true" />
                      </button>
                    </div>
                    {/* 世界开关：只有本实例配了 3D 空间（world.enabled）才显示，避免用户点了进不去 */}
                    {world?.enabled ? (
                      <div className="agent-row__switch">
                        <span className="agent-row__switch-text">
                          进入 3D 空间
                          <small>{agent.canEnterWorld ? '已允许：它可以进 3D 世界走动、说话、做表情' : '已关闭：world_* 工具会被拒绝'}</small>
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={agent.canEnterWorld === true}
                          aria-label="允许进入 3D 空间"
                          className={cn('switch', agent.canEnterWorld && 'switch--on')}
                          disabled={switchBusy !== null}
                          onClick={() => void toggleSwitch(agent, 'world')}
                        >
                          <span className="switch__knob" aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="agent-row__actions">
                    <button type="button" className="btn btn--sm" onClick={() => openAvatar(agent)}>
                      头像
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => void openMemberships(agent)}>
                      群设置
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => void openLimits(agent)}>
                      发言额度
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => void openTokens(agent)}>
                      接入钥匙
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => void openConfig(agent)}>
                      配置 / 接入
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => void togglePause(agent)}>
                      {agent.status === 'paused' ? '恢复' : '暂停'}
                    </button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setStopTarget(agent)}>
                      停用
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="card__title">新建 AI 成员</h2>

          <label className="field">
            <span className="field__label">名称</span>
            <input
              className="input"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：小助手"
            />
          </label>

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          <button type="button" className="btn btn--primary" onClick={() => void createAgent()} disabled={busy}>
            {busy ? '创建中…' : '创建 AI'}
          </button>
        </section>
      </div>

      {detail ? <ConfigDialog detail={detail} onClose={() => setDetail(null)} onCopy={(text, label) => void handleCopy(text, label)} /> : null}

      {tokensFor ? (
        <TokensDialog
          agent={tokensFor}
          tokens={tokens}
          busyId={tokenBusy}
          onClose={() => {
            setTokensFor(null)
            setTokens([])
          }}
          onRevoke={(token) => void revokeToken(token)}
        />
      ) : null}

      {limitsFor ? (
        <LimitsDialog
          agent={limitsFor}
          quota={quota}
          form={limitsForm}
          busy={limitsBusy}
          onClose={() => {
            setLimitsFor(null)
            setQuota(null)
          }}
          onFormChange={(patch) => setLimitsForm((prev) => ({ ...prev, ...patch }))}
          onSave={() => void saveLimits()}
        />
      ) : null}

      {membership ? (
        <MembershipsDialog
          membership={membership}
          onClose={() => setMembership(null)}
          onUpdate={(row, patch) => void updateMembership(row, patch)}
        />
      ) : null}

      {avatarEdit ? (
        <AvatarDialog
          edit={avatarEdit}
          onClose={() => setAvatarEdit(null)}
          onChangeUrl={(url) => setAvatarEdit((prev) => (prev ? { ...prev, url } : prev))}
          onSave={() => void saveAgentAvatar()}
          onClear={() => void clearAgentAvatar()}
        />
      ) : null}

      {stopTarget ? (
        <StopAgentDialog
          agent={stopTarget}
          onCancel={() => setStopTarget(null)}
          onConfirm={() => void removeAgent(stopTarget)}
        />
      ) : null}
    </div>
  )
}
