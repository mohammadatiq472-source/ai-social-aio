import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { AdminReport, WaitlistItem } from '../types'
import { cn, copyText, formatRelative } from '../utils'
import { ConfirmDialog } from './ConfirmDialog'
import { AdminInvites } from './admin/AdminInvites'

/** 三种处理动作：驳回 / 下架消息 / 封禁 7 天（文案要让站务一眼知道后果） */
const ACTIONS: { key: 'dismiss' | 'hide_message' | 'suspend_user'; label: string; hint: string }[] = [
  { key: 'dismiss', label: '驳回', hint: '不动内容，只把举报结掉' },
  { key: 'hide_message', label: '隐藏消息', hint: '所有成员都看不到原文，审计里仍留着' },
  { key: 'suspend_user', label: '封禁 7 天', hint: '发送者 7 天内不能发言、不能登录' },
]

type StatusTab = 'open' | 'resolved' | 'dismissed' | 'suspended' | 'invites' | 'waitlist' | 'tools'

/** 页签文案：邀请是站务发号入口，和举报/封禁并排 */
const TAB_TEXT: Record<StatusTab, string> = {
  open: '待处理',
  resolved: '已处理',
  dismissed: '已驳回',
  suspended: '已封禁',
  invites: '邀请',
  waitlist: '候补',
  tools: '工具',
}

/** 事件里存的是动作 key，页面上要显示人话 */
const ACTION_TEXT: Record<string, string> = {
  dismiss: '驳回',
  hide_message: '隐藏消息',
  suspend_user: '封禁 7 天',
}

/** 已封禁账号（GET /api/admin/suspended 的投影） */
interface SuspendedUser {
  principalId: number
  displayName: string
  accountNo: number | null
  suspendedUntil: string
  lastSuspendedAt: string | null
}

/**
 * 解封的两个接口还没进 `web/src/api.ts`（本轮改动只允许动 AdminView），就地封装。
 * 错误仍统一成 ApiError：组件里 401/403/404 的判断和其它页面保持同一套语义。
 */
async function adminFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: hasBody
      ? { Accept: 'application/json', 'Content-Type': 'application/json' }
      : { Accept: 'application/json' },
    body: hasBody ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!res.ok) {
    const record = (payload ?? {}) as { error?: string; message?: string }
    throw new ApiError(res.status, record.error ?? 'server_error', record.message || `请求失败（${res.status}）`)
  }
  return payload as T
}

/** 解封时间在未来，formatRelative 会把未来时间当成「刚刚」，所以按剩余时长单独算 */
function formatUntil(iso: string): string {
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return '未知'
  const left = at - Date.now()
  if (left <= 0) return '已到期'
  const hours = Math.ceil(left / 3_600_000)
  return hours < 24 ? `还剩 ${hours} 小时` : `还剩 ${Math.ceil(hours / 24)} 天`
}

interface AdminViewProps {
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

/**
 * 审核页：举报列表 + 处理。
 * 只有 principal.is_admin 能进（App 层已按 me.isAdmin 隐藏入口，服务端还会再校验一次）。
 * 处理动作会写事件（ReportHandled / MessageHidden / UserSuspended），审计可追。
 */
export function AdminView({ notify }: AdminViewProps) {
  const [status, setStatus] = useState<StatusTab>('open')
  const [reports, setReports] = useState<AdminReport[]>([])
  const [suspended, setSuspended] = useState<SuspendedUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [noteFor, setNoteFor] = useState<Record<number, string>>({})
  // 解封的二次确认做成就地切换（不用 window.confirm：阻塞式弹窗在移动端/深色模式下都不可控）
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [unbanBusy, setUnbanBusy] = useState<number | null>(null)
  // 封禁是重操作：页面级二次确认（不用 window.confirm，也不用嵌套 Modal）
  const [confirmSuspend, setConfirmSuspend] = useState<AdminReport | null>(null)
  // 站务工具：手动置「邮箱已验证」（发信挂了时的兜底出口，见 submit.admin_verify_email）
  const [toolInput, setToolInput] = useState('')
  const [toolNote, setToolNote] = useState('')
  const [toolBusy, setToolBusy] = useState(false)
  const [toolResult, setToolResult] = useState<string | null>(null)
  // 候补队列：站务在这里发码（明文只显示一次）或拒绝
  const [waitlist, setWaitlist] = useState<WaitlistItem[]>([])
  const [wlBusy, setWlBusy] = useState<number | null>(null)
  const [issued, setIssued] = useState<{ id: number; email: string; code: string } | null>(null)

  const load = useCallback(
    async (next: StatusTab) => {
      setLoading(true)
      setError(null)
      setConfirmId(null)
      try {
        if (next === 'waitlist') {
          const res = await adminFetch<{ items?: WaitlistItem[] }>('/api/admin/waitlist?status=pending')
          setWaitlist(Array.isArray(res.items) ? res.items : [])
          setReports([])
          setSuspended([])
        } else if (next === 'invites' || next === 'tools') {
          // 邀请页自己拉 /api/admin/invites；这里只清空举报/封禁列表，不发多余的列表请求
          setReports([])
          setSuspended([])
        } else if (next === 'suspended') {
          const res = await adminFetch<{ users?: SuspendedUser[] }>('/api/admin/suspended')
          setSuspended(Array.isArray(res.users) ? res.users : [])
          setReports([])
        } else {
          const list = await api.adminReports(next)
          setReports(list)
          setSuspended([])
        }
      } catch (err) {
        // 403 说明不是站务（比如权限被撤了）：不要假装是网络错误
        if (err instanceof ApiError && err.code === 'forbidden') setError('没有站务权限')
        else if (!(err instanceof ApiError && err.code === 'unauthorized')) {
          setError(err instanceof ApiError ? err.message : '加载失败，请重试')
        }
        setReports([])
        setSuspended([])
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load(status)
  }, [load, status])

  /** 候补发码：成功后把明文码显示在卡片里（库里只有 HMAC，刷新就看不到了） */
  async function issueWaitlistCode(item: WaitlistItem) {
    if (wlBusy != null) return
    setWlBusy(item.id)
    try {
      const out = await adminFetch<{ id: number; email: string; code: string }>(`/api/admin/waitlist/${item.id}/issue`, {
        method: 'POST',
        body: {},
      })
      setIssued({ id: out.id, email: out.email, code: out.code })
      setWaitlist((prev) => prev.filter((x) => x.id !== item.id))
      notify('已生成邀请码，复制后发给对方', 'success')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_decided') notify('这条已经处理过了', 'info')
      else notify(err instanceof ApiError ? err.message : '发码失败', 'error')
    } finally {
      setWlBusy(null)
    }
  }

  async function rejectWaitlistItem(item: WaitlistItem) {
    if (wlBusy != null) return
    setWlBusy(item.id)
    try {
      await adminFetch(`/api/admin/waitlist/${item.id}/reject`, { method: 'POST', body: {} })
      setWaitlist((prev) => prev.filter((x) => x.id !== item.id))
      notify('已拒绝', 'info')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败', 'error')
    } finally {
      setWlBusy(null)
    }
  }

  /** 站务手动置「邮箱已验证」：账号号段是 10000001+，小于它就是 principal id */
  async function manualVerifyEmail() {
    if (toolBusy) return
    const raw = Number(toolInput)
    if (!Number.isInteger(raw) || raw <= 0) {
      notify('请填账号号或 principal id', 'error')
      return
    }
    const body = raw >= 10_000_000 ? { account_no: raw, note: toolNote } : { principal_id: raw, note: toolNote }
    setToolBusy(true)
    setToolResult(null)
    try {
      const out = await adminFetch<{ principal_id: number; display_name?: string }>('/api/admin/verify-email', {
        method: 'POST',
        body,
      })
      setToolResult(`已置为已验证：${out.display_name || ''}（id=${out.principal_id}）`)
      notify(`已放行 ${out.display_name || raw}`, 'success')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      const msg =
        err instanceof ApiError && err.code === 'not_found'
          ? '没找到，或这个账号已经是已验证状态'
          : err instanceof ApiError
            ? err.message
            : '操作失败，请重试'
      setToolResult(msg)
      notify(msg, 'error')
    } finally {
      setToolBusy(false)
    }
  }

  /** 解封：第一次点只把按钮切成「确认解封？/取消」，第二次才真的发请求 */
  async function unban(user: SuspendedUser) {
    if (unbanBusy != null) return
    setUnbanBusy(user.principalId)
    try {
      await adminFetch(`/api/admin/unsuspend/${user.principalId}`, { method: 'POST', body: {} })
      notify(`已解封：${user.displayName}`, 'success')
      setSuspended((prev) => prev.filter((item) => item.principalId !== user.principalId))
      setConfirmId(null)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      // 404 = 已被别的站务解封，或封禁已到期自动失效：不是失败，按「已不在封禁中」处理并刷新提示
      if (err instanceof ApiError && err.code === 'not_found') {
        notify('这个账号已经不在封禁中了，列表已刷新', 'info')
        setSuspended((prev) => prev.filter((item) => item.principalId !== user.principalId))
        setConfirmId(null)
        return
      }
      notify(err instanceof ApiError ? err.message : '解封失败，请重试', 'error')
    } finally {
      setUnbanBusy(null)
    }
  }

  async function handle(report: AdminReport, action: 'dismiss' | 'hide_message' | 'suspend_user', confirmed = false) {
    if (busyId != null) return
    const note = (noteFor[report.id] || '').trim()
    if (action !== 'dismiss' && !note) {
      notify('隐藏消息/封禁需要写一句备注（审计要看为什么）', 'info')
      return
    }
    const label = ACTIONS.find((item) => item.key === action)?.label ?? action
    if (action === 'suspend_user' && !confirmed) {
      setConfirmSuspend(report)
      return
    }
    setBusyId(report.id)
    try {
      await api.handleReport(report.id, action, note)
      notify(`已处理：${label}`, 'success')
      setReports((prev) => prev.filter((item) => item.id !== report.id))
      setNoteFor((prev) => {
        const next = { ...prev }
        delete next[report.id]
        return next
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      notify(err instanceof ApiError ? err.message : '处理失败，请重试', 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
    <div className="admin">
      <div className="admin__inner">
        <header className="admin__head">
          <h1 className="admin__title">审核</h1>
          <div className="admin__tabs" role="tablist" aria-label="审核分段">
            {(['open', 'resolved', 'dismissed', 'suspended', 'invites', 'waitlist', 'tools'] as StatusTab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={status === key}
                className={cn('admin__tab', status === key && 'admin__tab--active')}
                onClick={() => setStatus(key)}
              >
                {TAB_TEXT[key]}
              </button>
            ))}
          </div>
        </header>

        {status === 'waitlist' ? (
          <section>
            {issued ? (
              <div className="admin-card">
                <div className="admin-card__head">
                  <span className="admin-card__kind">邀请码（只显示这一次）</span>
                </div>
                <p className="admin-card__meta">{issued.email}</p>
                <p className="admin-card__reason">{issued.code}</p>
                <div className="admin-card__head">
                  <button type="button" className="admin-card__btn admin-card__btn--primary" onClick={() => void copyText(issued.code)}>
                    复制邀请码
                  </button>
                  <button type="button" className="admin-card__btn" onClick={() => setIssued(null)}>
                    关闭
                  </button>
                </div>
              </div>
            ) : null}

            {loading ? <p className="admin__empty">正在加载…</p> : null}
            {!loading && waitlist.length === 0 ? <p className="admin__empty">没有待处理的候补申请</p> : null}
            <ul className="admin__list">
              {waitlist.map((item) => (
                <li key={item.id} className="admin-card">
                  <div className="admin-card__head">
                    <span className="admin-card__kind">{item.emailMasked}</span>
                  </div>
                  {item.note ? <p className="admin-card__quote">{item.note}</p> : null}
                  <p className="admin-card__meta">申请于 {formatRelative(item.createdAt)}</p>
                  <div className="admin-card__head">
                    <button
                      type="button"
                      className="admin-card__btn admin-card__btn--primary"
                      disabled={wlBusy === item.id}
                      onClick={() => void issueWaitlistCode(item)}
                    >
                      {wlBusy === item.id ? '处理中…' : '发码'}
                    </button>
                    <button type="button" className="admin-card__btn" disabled={wlBusy === item.id} onClick={() => void rejectWaitlistItem(item)}>
                      拒绝
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : status === 'tools' ? (
          <section className="admin-card">
            <div className="admin-card__head">
              <span className="admin-card__kind">手动置「邮箱已验证」</span>
            </div>
            <p className="admin-card__meta">
              用于兜底：实例开了 <code>EMAIL_VERIFY_MODE=required</code> 却发不出信，或用户邮箱本身收不到信。
              只放行这一个账号，并写一条 <code>UserEmailVerifiedManually</code> 事件留痕。
            </p>
            <label className="admin-card__meta" htmlFor="admin-verify-target">
              账号号（10000001+）或 principal id
            </label>
            <input
              id="admin-verify-target"
              className="input"
              inputMode="numeric"
              value={toolInput}
              onChange={(event) => setToolInput(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="例如 10000042"
            />
            <label className="admin-card__meta" htmlFor="admin-verify-note">
              备注（会写进事件，可选）
            </label>
            <input
              id="admin-verify-note"
              className="input"
              value={toolNote}
              maxLength={200}
              onChange={(event) => setToolNote(event.target.value)}
              placeholder="例如：用户邮箱收不到信，人工核过身份"
            />
            <div className="admin-card__head">
              <button
                type="button"
                className="admin-card__btn admin-card__btn--primary"
                disabled={toolBusy || !toolInput}
                onClick={() => void manualVerifyEmail()}
              >
                {toolBusy ? '处理中…' : '置为已验证'}
              </button>
            </div>
            {toolResult ? <p className="admin-card__meta">{toolResult}</p> : null}
          </section>
        ) : status === 'invites' ? (
          <AdminInvites notify={notify} />
        ) : (
          <>
            {error ? <p className="admin__empty">{error}</p> : null}
        {!error && loading ? <p className="admin__empty">正在加载…</p> : null}
        {!error && !loading && (status === 'suspended' ? suspended.length === 0 : reports.length === 0) ? (
          <p className="admin__empty">
            {status === 'open' ? '没有待处理的举报' : status === 'suspended' ? '没有被封禁的账号' : '这里还没有记录'}
          </p>
        ) : null}

        <ul className="admin__list">
          {status === 'suspended'
            ? suspended.map((user) => (
              <li key={user.principalId} className="admin-card">
                <div className="admin-card__head">
                  <span className="admin-card__kind">
                    {user.displayName}
                    {user.accountNo != null ? ` #${user.accountNo}` : ''}
                  </span>
                  <span className="admin-card__time">{formatUntil(user.suspendedUntil)}</span>
                </div>
                <div className="admin-card__meta">
                  <span>账号 ID：{user.principalId}</span>
                  {user.lastSuspendedAt ? <span>最近封禁：{formatRelative(user.lastSuspendedAt)}</span> : null}
                </div>
                <div className="admin-card__actions">
                  {confirmId === user.principalId ? (
                    <>
                      <button
                        type="button"
                        className="admin-card__btn admin-card__btn--danger"
                        disabled={unbanBusy === user.principalId}
                        onClick={() => void unban(user)}
                      >
                        确认解封？
                      </button>
                      <button
                        type="button"
                        className="admin-card__btn"
                        disabled={unbanBusy === user.principalId}
                        onClick={() => setConfirmId(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="admin-card__btn admin-card__btn--primary"
                      disabled={unbanBusy === user.principalId}
                      onClick={() => setConfirmId(user.principalId)}
                    >
                      解封
                    </button>
                  )}
                </div>
              </li>
            ))
            : reports.map((report) => (
              <li key={report.id} className="admin-card">
                <div className="admin-card__head">
                  <span className="admin-card__kind">
                    {report.targetType === 'message' ? '消息' : report.targetType === 'feed' ? '说说' : '表情包'}
                    #{report.targetId}
                  </span>
                  <span className="admin-card__time">{formatRelative(report.createdAt)}</span>
                </div>

                {report.messagePreview ? (
                  <p className="admin-card__quote">
                    {report.messageSender ? <b>{report.messageSender}：</b> : null}
                    {report.messagePreview}
                  </p>
                ) : null}

                <div className="admin-card__meta">
                  {report.conversationTitle ? <span>来自「{report.conversationTitle}」</span> : null}
                  <span>举报人：{report.reporterName}</span>
                </div>
                <p className="admin-card__reason">理由：{report.reason}</p>

                {report.status === 'open' ? (
                  <>
                    <input
                      className="admin-card__note"
                      placeholder="处理备注（隐藏/封禁必填）"
                      value={noteFor[report.id] ?? ''}
                      onChange={(event) => setNoteFor((prev) => ({ ...prev, [report.id]: event.target.value }))}
                      maxLength={200}
                    />
                    <div className="admin-card__actions">
                      {ACTIONS.map((action) => (
                        <button
                          key={action.key}
                          type="button"
                          className={cn('admin-card__btn', action.key === 'suspend_user' && 'admin-card__btn--danger')}
                          title={action.hint}
                          disabled={busyId === report.id}
                          onClick={() => void handle(report, action.key)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="admin-card__meta">
                    <span>处理：{report.action ? (ACTION_TEXT[report.action] ?? report.action) : '—'}</span>
                    {report.handlerName ? <span>处理人：{report.handlerName}</span> : null}
                    {report.handledAt ? <span>{formatRelative(report.handledAt)}</span> : null}
                    {report.actionNote ? <span>备注：{report.actionNote}</span> : null}
                  </div>
                )}
              </li>
            ))}
        </ul>
          </>
        )}
      </div>
    </div>
    {confirmSuspend ? (
      <ConfirmDialog
        title="封禁账号"
        danger
        busy={busyId === confirmSuspend.id}
        confirmText="封禁 7 天"
        onCancel={() => setConfirmSuspend(null)}
        onConfirm={() => {
          const target = confirmSuspend
          setConfirmSuspend(null)
          if (target) void handle(target, 'suspend_user', true)
        }}
      >
        <p>确认封禁这条消息的发送者 7 天？</p>
        <p>封禁后对方无法登录、无法发言；可以在「已封禁」页签里随时解封。</p>
      </ConfirmDialog>
    ) : null}
    </>
  )
}