import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { Member, MemberRole } from '../types'
import { Avatar } from './Avatar'
import { Modal } from './Modal'

interface GroupSettingsDialogProps {
  conversationId: number
  conversationTitle: string
  /** 我在这个群的角色：owner 能设管理员；admin 只能移出普通成员 */
  myRole: MemberRole
  myId: number
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
  /** 当前群公告（纯文本）；由 ChatView 从会话列表带进来，避免再开一个 GET */
  announcement?: string
  /** 公告更新时间；保存「内容没变」时后端不返回新时间，用它兜底，别把已有时间擦掉 */
  announcementUpdatedAt?: string | null
  /** 公告保存成功后回传给 ChatView，让聊天页公告条立刻更新（不做实时推送） */
  onAnnouncementSaved?: (announcement: string, announcementUpdatedAt: string | null) => void
  onClose: () => void
  /** 解散成功后：外壳清掉当前会话并刷新列表 */
  onDissolved?: () => void
}

/**
 * 群 AI 设置（只对群主/管理员开放）。
 * 这些是「整群口径」：每轮最多几个 AI 接话、AI→AI 接力到多深、整群 AI 每天合计多少条。
 * 单只 AI 的额度不在这里——那是它主人在「我的 AI → 发言额度」里管的。
 */
export function GroupSettingsDialog({ conversationId, conversationTitle, myRole, myId, notify, announcement, announcementUpdatedAt, onAnnouncementSaved, onClose, onDissolved }: GroupSettingsDialogProps) {
  const [form, setForm] = useState({ round: '', depth: '', daily: '' })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [memberBusy, setMemberBusy] = useState(0)
  // 危险区：转让群主（选人）/ 解散群（输入群名确认）
  const [transferTo, setTransferTo] = useState('')
  const [confirmTransfer, setConfirmTransfer] = useState(false)
  const [dissolveText, setDissolveText] = useState('')
  const [confirmDissolve, setConfirmDissolve] = useState(false)
  const [dangerBusy, setDangerBusy] = useState(false)
  // 公开推荐（群广场）：群主/管理员可把群放出来；审批制时这里能看到申请
  const [pub, setPub] = useState({ discoverable: false, joinMode: 'approval' as 'open' | 'approval', description: '' })
  const [pubBusy, setPubBusy] = useState(false)
  const [requests, setRequests] = useState<Array<{ principal_id: number; display_name: string; account_no: number | null; created_at: string }>>([])
  // 群公告（群规）：纯文本 ≤2000。只有群主/管理员能进本弹窗，服务端仍会再校验一次。
  const [ann, setAnn] = useState(announcement ?? '')
  const [annBusy, setAnnBusy] = useState(false)

  useEffect(() => {
    setAnn(announcement ?? '')
  }, [announcement])

  const loadMembers = useCallback(async () => {
    try {
      const res = await api.conversationMembers(conversationId)
      setMembers(res.members || [])
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '成员读取失败', 'error')
    }
  }, [conversationId, notify])

  useEffect(() => {
    let alive = true
    api
      .groupAgentSettings(conversationId)
      .then((res) => {
        if (!alive) return
        setReady(true)
        setForm({
          round: String(res.roundQuota),
          depth: String(res.relayDepth),
          daily: String(res.groupDailyLimit),
        })
        void loadMembers()
        void api.groupPublic(conversationId).then((v) => setPub(v)).catch(() => {})
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? err.message : '设置读取失败')
      })
    return () => {
      alive = false
    }
  }, [conversationId, loadMembers])

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await api.setGroupAgentSettings(conversationId, {
        roundQuota: Number(form.round),
        relayDepth: Number(form.depth),
        groupDailyLimit: Number(form.daily),
      })
      setReady(true)
      notify('群 AI 设置已更新，群里的 AI 下一次调用就能读到', 'success')
      onClose()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '保存失败，请重试', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(member: Member, role: 'admin' | 'member') {
    if (memberBusy) return
    setMemberBusy(member.id)
    try {
      await api.setMemberRole(conversationId, member.id, role)
      await loadMembers()
      notify(role === 'admin' ? `已把「${member.displayName}」设为管理员` : `已取消「${member.displayName}」的管理员`, 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '设置角色失败', 'error')
    } finally {
      setMemberBusy(0)
    }
  }

  async function removeMember(member: Member) {
    if (memberBusy) return
    setMemberBusy(member.id)
    try {
      await api.removeMember(conversationId, member.id)
      await loadMembers()
      notify(`已把「${member.displayName}」移出群`, 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '移出失败', 'error')
    } finally {
      setMemberBusy(0)
    }
  }

  /** 可以接群主的：群里的人类成员（AI 没有网页界面，不能当群主） */
  const transferTargets = members.filter((m) => m.type === 'user' && m.role !== 'owner')

  async function doTransfer() {
    const target = Number(transferTo)
    if (!target || dangerBusy) return
    setDangerBusy(true)
    try {
      await api.transferOwner(conversationId, target)
      const name = members.find((m) => m.id === target)?.displayName ?? '对方'
      notify(`已把群主转让给「${name}」。你现在是普通成员，可以自己退群。`, 'success')
      onClose()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '转让失败', 'error')
    } finally {
      setDangerBusy(false)
    }
  }

  async function doDissolve() {
    if (dangerBusy) return
    setDangerBusy(true)
    try {
      await api.dissolveConversation(conversationId)
      notify('群已解散', 'success')
      onDissolved?.()
      onClose()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '解散失败', 'error')
    } finally {
      setDangerBusy(false)
    }
  }

  async function savePublic() {
    if (pubBusy) return
    setPubBusy(true)
    try {
      await api.updateGroupPublic(conversationId, {
        discoverable: pub.discoverable,
        joinMode: pub.joinMode,
        description: pub.description.slice(0, 120),
      })
      notify(pub.discoverable ? '已放到群广场，别人可以搜到这个群' : '已从群广场撤下', 'success')
      if (pub.discoverable && pub.joinMode === 'approval') {
        const res = await api.groupJoinRequests(conversationId)
        setRequests(res.requests || [])
      }
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '保存失败', 'error')
    } finally {
      setPubBusy(false)
    }
  }

  async function saveAnnouncement() {
    if (annBusy) return
    setAnnBusy(true)
    try {
      const res = await api.updateAnnouncement(conversationId, ann.slice(0, 2000))
      // 回传父级：公告条不靠实时推送，保存后由 ChatView 本地更新。
      // 内容没变时后端返回 changed:false 且不带时间戳 —— 用旧值兜底，别把「更新时间」擦成空。
      onAnnouncementSaved?.(res.announcement, res.announcementUpdatedAt ?? announcementUpdatedAt ?? null)
      notify(ann.trim() ? '群公告已保存，群成员会在聊天页看到' : '群公告已清空', 'success')
      onClose()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '公告保存失败，请重试', 'error')
    } finally {
      setAnnBusy(false)
    }
  }

  async function loadRequests() {
    try {
      const res = await api.groupJoinRequests(conversationId)
      setRequests(res.requests || [])
    } catch {
      /* 非群主/管理员会 403，忽略 */
    }
  }

  async function decideRequest(principalId: number, accept: boolean) {
    try {
      await api.decideJoinRequest(conversationId, principalId, accept)
      notify(accept ? '已同意入群' : '已拒绝', 'success')
      await loadRequests()
      await loadMembers()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败', 'error')
    }
  }

  const owner = members.find((m) => m.role === 'owner')
  const admins = members.filter((m) => m.role === 'admin')
  const plain = members.filter((m) => m.role !== 'owner' && m.role !== 'admin')

  function memberRow(member: Member) {
    const isOwner = member.role === 'owner'
    const isAdmin = member.role === 'admin'
    const isMe = member.id === myId
    // 群主：能设/取消管理员、能移出任何人（除了自己）。
    // 管理员：只能移出普通成员（管理员之间要群主动手）。
    const canPromote = myRole === 'owner' && !isOwner && !isMe
    const canRemove = !isOwner && !isMe && (myRole === 'owner' || (myRole === 'admin' && !isAdmin))
    return (
      <li key={member.id} className="gs-member">
        <Avatar name={member.displayName} hue={member.avatarHue ?? 220} type={member.type} size="sm" url={member.avatarUrl} />
        <span className="gs-member__name">
          {member.displayName}
          {isMe ? <span className="gs-member__me">（我）</span> : null}
        </span>
        {isOwner ? <span className="gs-member__role">群主</span> : null}
        {isAdmin ? <span className="gs-member__role gs-member__role--admin">管理员</span> : null}
        <span className="gs-member__actions">
          {canPromote ? (
            <button type="button" className="btn btn--sm" disabled={memberBusy === member.id}
              onClick={() => void changeRole(member, isAdmin ? 'member' : 'admin')}>
              {isAdmin ? '取消管理员' : '设为管理员'}
            </button>
          ) : null}
          {canRemove ? (
            <button type="button" className="btn btn--sm btn--danger" disabled={memberBusy === member.id}
              onClick={() => void removeMember(member)}>
              移出
            </button>
          ) : null}
        </span>
      </li>
    )
  }

  return (
    <Modal
      title={`${conversationTitle} · 群设置`}
      onClose={onClose}
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy || !ready}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!error && !ready ? <p className="card__hint">正在读取…</p> : null}
      {ready ? (
        <div className="group-settings">
          <p className="group-settings__hint">
            这些是整群口径，只对群主/管理员可见。单只 AI 的额度（每日上限、突发容量）由它主人在
            「我的 → 我的 AI → 发言额度」里调整，不在这里。
          </p>
          <label className="field">
            <span className="field__label">每轮最多几个 AI 接话</span>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={form.round}
              onChange={(event) => setForm((prev) => ({ ...prev, round: event.target.value }))}
            />
            <span className="field__hint">同一条人类消息触发 AI 回复的上限；AI 重度群可以调到 4~6。</span>
          </label>
          <label className="field">
            <span className="field__label">AI 之间最多接力几层</span>
            <input
              className="input"
              type="number"
              min={0}
              max={10}
              value={form.depth}
              onChange={(event) => setForm((prev) => ({ ...prev, depth: event.target.value }))}
            />
            <span className="field__hint">0 = AI 不回 AI；默认 2，调高会把「AI 互相接力」的风险交给熔断兜。</span>
          </label>
          <label className="field">
            <span className="field__label">全群 AI 每日合计上限（条）</span>
            <input
              className="input"
              type="number"
              min={0}
              max={100000}
              value={form.daily}
              onChange={(event) => setForm((prev) => ({ ...prev, daily: event.target.value }))}
            />
            <span className="field__hint">0 = 不限。默认 600；这是整群所有 AI 加起来的日预算。</span>
          </label>

          <div className="gs-members">
            <h3 className="gs-members__title">成员（{members.length}）</h3>
            <p className="group-settings__hint">
              群主可以把成员设为管理员（能改群设置、拉人踢人）；管理员只能移出普通成员。
              移出后对方会立刻失去这个群的读写权限。
            </p>
            {members.length === 0 ? <p className="card__hint">正在读取成员…</p> : null}
            {owner ? <ul className="gs-member-list">{memberRow(owner)}</ul> : null}
            {admins.length ? <ul className="gs-member-list">{admins.map(memberRow)}</ul> : null}
            {plain.length ? <ul className="gs-member-list">{plain.map(memberRow)}</ul> : null}
          </div>

          {/* 群公告：聊天页顶部只读条的数据源；纯文本，不进 markdown 渲染 */}
          <div className="gs-announcement">
            <div className="gs-announcement__head">
              <h3 className="gs-members__title">群公告（群规）</h3>
              <span className="gs-announcement__count" data-testid="group-announcement-count">
                {Array.from(ann).length} / 2000
              </span>
            </div>
            <p className="group-settings__hint">
              纯文本，最多 2000 字；保存后群成员会在聊天页顶部看到（可展开看全文）。清空后公告条不再显示。
            </p>
            <textarea
              className="input input--area"
              aria-label="群公告（群规）"
              data-testid="group-announcement-input"
              rows={5}
              maxLength={2000}
              value={ann}
              placeholder="例如：本群只聊 AI 与产品；发链接前先说明用途；吵架请私聊。"
              onChange={(event) => setAnn(event.target.value)}
              disabled={annBusy}
            />
            <div className="gs-announcement__actions">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                data-testid="group-announcement-save"
                onClick={() => void saveAnnouncement()}
                disabled={annBusy}
              >
                {annBusy ? '保存中…' : '保存公告'}
              </button>
              <span className="gs-announcement__hint">保存后会关闭设置，聊天页公告条立即更新</span>
            </div>
          </div>

          <div className="gs-public">
            <h3 className="gs-members__title">公开推荐（群广场）</h3>
            <p className="group-settings__hint">
              放出来之后，别人在「发现群聊」里能搜到这个群。自由加入 = 点一下就进；需审批 = 你在这里批。
            </p>
            <label className="gs-public__row">
              <input
                type="checkbox"
                checked={pub.discoverable}
                onChange={(event) => setPub((prev) => ({ ...prev, discoverable: event.target.checked }))}
              />
              放到群广场
            </label>
            {pub.discoverable ? (
              <>
                <label className="gs-public__row">
                  加入方式
                  <select
                    className="input gs-danger__select"
                    value={pub.joinMode}
                    onChange={(event) => setPub((prev) => ({ ...prev, joinMode: event.target.value as 'open' | 'approval' }))}
                  >
                    <option value="approval">需群主审批</option>
                    <option value="open">自由加入</option>
                  </select>
                </label>
                <input
                  className="input"
                  value={pub.description}
                  maxLength={120}
                  placeholder="一句话介绍（显示在群广场）"
                  onChange={(event) => setPub((prev) => ({ ...prev, description: event.target.value }))}
                />
              </>
            ) : null}
            <div className="gs-public__actions">
              <button type="button" className="btn btn--sm" disabled={pubBusy} onClick={() => void savePublic()}>
                {pubBusy ? '保存中…' : '保存公开设置'}
              </button>
              {pub.discoverable && pub.joinMode === 'approval' ? (
                <button type="button" className="btn btn--sm" onClick={() => void loadRequests()}>
                  刷新申请（{requests.length}）
                </button>
              ) : null}
            </div>
            {requests.length > 0 ? (
              <ul className="gs-member-list">
                {requests.map((r) => (
                  <li key={r.principal_id} className="gs-member">
                    <span className="gs-member__name">{r.display_name}</span>
                    <span className="gs-member__actions">
                      <button type="button" className="btn btn--sm btn--primary" onClick={() => void decideRequest(r.principal_id, true)}>
                        同意
                      </button>
                      <button type="button" className="btn btn--sm" onClick={() => void decideRequest(r.principal_id, false)}>
                        拒绝
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {myRole === 'owner' ? (
            <div className="gs-danger">
              <h3 className="gs-members__title">群主操作</h3>

              <div className="gs-danger__row">
                <span className="gs-danger__label">转让群主</span>
                <select
                  className="input gs-danger__select"
                  aria-label="选择新群主"
                  value={transferTo}
                  onChange={(event) => {
                    setTransferTo(event.target.value)
                    setConfirmTransfer(false)
                  }}
                >
                  <option value="">选择一位人类成员…</option>
                  {transferTargets.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
                {confirmTransfer ? (
                  <span className="gs-danger__confirm">
                    转让后你是普通成员，可以自己退群。
                    <button type="button" className="btn btn--sm" disabled={dangerBusy} onClick={() => void doTransfer()}>
                      确认转让
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => setConfirmTransfer(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn btn--sm" disabled={!transferTo} onClick={() => setConfirmTransfer(true)}>
                    转让
                  </button>
                )}
              </div>

              <div className="gs-danger__row gs-danger__row--dissolve">
                <span className="gs-danger__label">解散群</span>
                <span className="gs-danger__hint">
                  不需要先把人踢完，解散后所有成员都会失去这个群的访问（消息记录保留在审计里）。
                  输入群名确认：
                </span>
                <input
                  className="input gs-danger__input"
                  aria-label="输入群名确认解散"
                  value={dissolveText}
                  onChange={(event) => {
                    setDissolveText(event.target.value)
                    setConfirmDissolve(false)
                  }}
                  placeholder={conversationTitle}
                />
                {confirmDissolve ? (
                  <span className="gs-danger__confirm">
                    真的解散「{conversationTitle}」？
                    <button type="button" className="btn btn--sm btn--danger" disabled={dangerBusy} onClick={() => void doDissolve()}>
                      确认解散
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => setConfirmDissolve(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={dissolveText.trim() !== conversationTitle}
                    onClick={() => setConfirmDissolve(true)}
                  >
                    解散
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
