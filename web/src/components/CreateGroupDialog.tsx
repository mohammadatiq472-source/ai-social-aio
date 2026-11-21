import { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../api'
import type { Conversation, Friend, PrincipalType } from '../types'
import { cn } from '../utils'
import { Avatar } from './Avatar'
import { Modal } from './Modal'

interface CreateGroupDialogProps {
  onClose: () => void
  onCreated: (conversation: Conversation) => void
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

interface Candidate {
  id: number
  type: PrincipalType
  displayName: string
  accountNo: number | null
  /** 图片头像；没有就回退几何头像 */
  avatarUrl?: string | null
  ownedByMe: boolean
}

/**
 * 新建群：候选人**只来自好友 + 自己的 AI**（后端也只允许拉这两类）。
 * 不再调用 /api/directory —— 绝不把陌生人摆出来让人点错。
 */
export function CreateGroupDialog({ onClose, onCreated, notify }: CreateGroupDialogProps) {
  const [title, setTitle] = useState('')
  const [keyword, setKeyword] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    Promise.all([api.friends(), api.agents()])
      .then(([friendData, agents]) => {
        if (!alive) return
        const fromFriends: Candidate[] = (friendData.friends ?? []).map((friend: Friend) => ({
          id: friend.id,
          type: friend.type,
          displayName: friend.displayName,
          accountNo: friend.accountNo ?? null,
          ownedByMe: false,
        }))
        const fromAgents: Candidate[] = agents.map((agent) => ({
          id: agent.id,
          type: 'agent' as const,
          displayName: agent.displayName,
          accountNo: agent.accountNo ?? null,
          ownedByMe: true,
        }))
        const merged = new Map<number, Candidate>()
        for (const item of [...fromFriends, ...fromAgents]) {
          const prev = merged.get(item.id)
          merged.set(item.id, prev ? { ...prev, ownedByMe: prev.ownedByMe || item.ownedByMe } : item)
        }
        setCandidates([...merged.values()])
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof ApiError ? err.message : '好友列表加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (item) => item.displayName.toLowerCase().includes(q) || (item.accountNo != null && String(item.accountNo).includes(q)),
    )
  }, [candidates, keyword])

  const humans = filtered.filter((item) => item.type === 'user')
  const agents = filtered.filter((item) => item.type === 'agent')

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  async function submit() {
    const trimmed = title.trim()
    if (trimmed.length < 1 || trimmed.length > 60) {
      setError('群名称需要 1–60 个字符')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await api.createConversation({ title: trimmed, memberIds: selected })
      notify('群创建成功', 'success')
      onCreated(res.conversation)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  function renderRow(item: Candidate) {
    const checked = selected.includes(item.id)
    return (
      <li key={item.id}>
        <label className={cn('pick-row', checked && 'pick-row--checked')}>
          <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />
          <Avatar name={item.displayName} hue={(item.id * 43) % 360} url={item.avatarUrl} type={item.type} size="sm" />
          <span className="pick-row__name">
            {item.displayName}
            {item.type === 'agent' ? <span className="ai-badge pick-row__ai">AI</span> : null}
          </span>
          <span className="pick-row__meta">{item.accountNo ?? ''}</span>
        </label>
      </li>
    )
  }

  const noFriends = !loading && candidates.length === 0

  return (
    <Modal
      title="新建群聊"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="modal__hint">已选 {selected.length} 人</span>
          <div className="modal__foot-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || loading || noFriends}>
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </>
      }
    >
      <label className="field">
        <span className="field__label">群名称</span>
        <input
          className="input"
          value={title}
          maxLength={60}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：周五晚自习"
          autoFocus
        />
      </label>

      <label className="field">
        <span className="field__label">搜索成员</span>
        <input
          className="input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="在好友和我的 AI 里搜索"
        />
      </label>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="pick-groups">
        {loading ? <p className="pick-empty">正在加载好友…</p> : null}

        {noFriends ? (
          <div className="pick-empty">
            <p>还没有好友，也没有自己的 AI。</p>
            <p className="pick-empty__hint">想拉人：先去「好友」按号码申请，对方同意后这里才会出现。</p>
          </div>
        ) : null}

        {!loading && !noFriends && filtered.length === 0 ? (
          <div className="pick-empty">
            <p>好友里没有这个人。</p>
            <p className="pick-empty__hint">想拉陌生人，先去「好友」按号码申请，对方同意后这里才会出现。</p>
          </div>
        ) : null}

        {humans.length > 0 ? (
          <section>
            <h3 className="pick-title">好友 {humans.length}</h3>
            <ul className="pick-list">{humans.map(renderRow)}</ul>
          </section>
        ) : null}

        {agents.length > 0 ? (
          <section>
            <h3 className="pick-title">我的 AI {agents.length}</h3>
            <ul className="pick-list">{agents.map(renderRow)}</ul>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}
