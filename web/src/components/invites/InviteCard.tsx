import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../api'
import type { InviteCode, InvitesMine, Notify } from '../../types'
import { copyText, formatDayLabel } from '../../utils'
import { Avatar } from '../Avatar'
import { ConfirmDialog } from '../ConfirmDialog'

interface InviteCardProps {
  notify: Notify
}

/** 后端偶发缺字段时不让整张卡崩掉 */
function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 到期时间：yyyy 年 m 月 d 日（formatDayLabel 已处理今天/昨天/跨年） */
function expiryText(iso: string | null): string {
  if (!iso) return '长期有效'
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return '有效期未知'
  const day = formatDayLabel(iso)
  if (!day) return '有效期未知'
  return time < Date.now() ? `已于 ${day} 过期` : `${day} 到期`
}

/**
 * 服务端只存哈希，GET 只回 4 位 codePrefix；完整格式是 AIO-XXXX-XXXX-XXXX，
 * 所以这里只能掩码展示——不要试图拼出可用的码。
 */
function maskedCode(codePrefix: string): string {
  const prefix = (codePrefix || '').trim().toUpperCase()
  return prefix ? `AIO-${prefix}-****-****` : 'AIO-****-****-****'
}

/**
 * 「我的」页的邀请卡片。
 *
 * 约束（2026-11 邀请功能）：
 * - 邀请码在服务端只存哈希，明文只在 POST /api/invites 响应的 invite.code 里出现一次。
 *   所以卡片对「已有码」只能显示掩码 + 吊销/重建，绝不能提供「复制旧码」。
 * - 明文只放进组件内 state（不写 localStorage/sessionStorage）：
 *   刷新即丢失是产品语义，不是 bug。
 * - 吊销用项目内 ConfirmDialog，不用 window.confirm（移动端/深色模式不可控）。
 */
export function InviteCard({ notify }: InviteCardProps) {
  const [data, setData] = useState<InvitesMine | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // null = 跟随服务端给的 defaultMaxUses；用户改过才变成字符串
  const [maxUsesInput, setMaxUsesInput] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)
  /** 创建成功后的一次性明文；离开页面/刷新就不再存在 */
  const [createdCode, setCreatedCode] = useState<string | null>(null)
  const codeRef = useRef<HTMLElement | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const quota = safeCount(data?.quota)
  const used = safeCount(data?.used)
  const remaining = safeCount(data?.remaining)
  const defaultMaxUses = safeCount(data?.defaultMaxUses) || Math.min(remaining, 100)
  const ttlDays = safeCount(data?.ttlDays) || 30
  // revokedAt 非空说明服务端把它当历史记录返回了：按「没有有效码」处理
  const activeCode: InviteCode | null = data?.active && !data.active.revokedAt ? data.active : null
  const invitees = data?.invitees ?? []

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const res = await api.myInvites()
      setData(res)
      setLoadError('')
    } catch (err) {
      // 401 由 App 统一退回登录页（api.ts 派发 qq:unauthorized），这里不重复提示
      if (err instanceof ApiError && err.code === 'unauthorized') return
      if (!quiet) setLoadError(err instanceof ApiError ? err.message : '邀请信息加载失败，请重试')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const maxUsesValue = maxUsesInput ?? String(defaultMaxUses)
  const maxUsesTrimmed = maxUsesValue.trim()
  const maxUsesNumber = Number(maxUsesTrimmed)
  // 服务端 max_uses 上限是 100，且不能超过 remaining
  const maxAllowed = Math.min(remaining, 100)
  const canSubmit =
    !creating &&
    !activeCode &&
    remaining > 0 &&
    /^\d+$/.test(maxUsesTrimmed) &&
    maxUsesNumber >= 1 &&
    maxUsesNumber <= maxAllowed

  async function createInvite() {
    if (creating) return
    if (!/^\d+$/.test(maxUsesTrimmed) || maxUsesNumber < 1 || maxUsesNumber > maxAllowed) {
      setFormError(`请填 1–${maxAllowed} 之间的整数`)
      return
    }
    setCreating(true)
    setFormError('')
    try {
      const res = await api.createInvite({ maxUses: maxUsesNumber, note: note.trim() || undefined })
      // 明文只活在这个 state 里：不落 storage，页面刷新即消失
      setCreatedCode(res.invite?.code ?? null)
      setMaxUsesInput(null)
      setNote('')
      // 先本地合并服务端返回的名额/邀请码，避免多等一次 GET；再静默校准
      setData((prev) =>
        prev
          ? {
              ...prev,
              quota: safeCount(res.quota) || prev.quota,
              used: safeCount(res.used),
              remaining: safeCount(res.remaining),
              defaultMaxUses: Math.min(safeCount(res.remaining), 100),
              active: res.invite ?? null,
              recent: res.invite ? [res.invite, ...prev.recent] : prev.recent,
            }
          : prev,
      )
      notify(
        res.revokedPrevious && res.revokedPrevious.length > 0
          ? '新邀请码已生成（旧码已自动吊销），只显示这一次'
          : '邀请码已生成，只显示这一次',
        'success',
      )
      await load(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      const message = err instanceof ApiError ? err.message : '创建邀请码失败，请重试'
      setFormError(message)
      notify(message, 'error')
      // 名额被别处用掉/超限：拉一次真实状态，让按钮和说明跟着变
      if (err instanceof ApiError && (err.status === 409 || err.code === 'no_remaining_quota')) await load(true)
    } finally {
      setCreating(false)
    }
  }

  async function copyCreatedCode() {
    if (!createdCode) return
    const ok = await copyText(createdCode)
    if (ok) {
      notify('邀请码已复制', 'success')
      return
    }
    // Clipboard API 被拒（非 HTTPS/权限）时回退到「选中文本 + 手动复制」：
    // 明文只出现这一次，不能让用户空手而归
    const element = codeRef.current
    if (element) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.addRange(range)
    }
    notify('已选中邀请码，请按 Ctrl+C 手动复制', 'info')
  }

  async function revokeCode() {
    if (!activeCode || revoking) return
    setRevoking(true)
    try {
      await api.revokeInvite(activeCode.id)
      setConfirmRevoke(false)
      setCreatedCode(null) // 刚生成的明文随吊销一起作废
      setMaxUsesInput(null)
      setData((prev) =>
        prev
          ? {
              ...prev,
              active: null,
              recent: prev.recent.map((item) =>
                item.id === activeCode.id ? { ...item, revokedAt: new Date().toISOString() } : item,
              ),
            }
          : prev,
      )
      notify('邀请码已吊销', 'success')
      await load(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      notify(err instanceof ApiError ? err.message : '吊销失败，请重试', 'error')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <>
      <section className="me-card invite">
        <h2 className="card__title">邀请朋友</h2>

        {loading ? <p className="card__hint">正在加载…</p> : null}

        {!loading && loadError ? (
          <div className="invite__section">
            <p className="invite__error" role="alert">
              {loadError}
            </p>
            <div className="invite__actions">
              <button type="button" className="btn btn--sm" onClick={() => void load()}>
                重试
              </button>
            </div>
          </div>
        ) : null}

        {!loading && !loadError ? (
          <>
            <p className="invite__quota">
              剩余名额 <strong>{remaining}</strong> / 共 {quota}
              {used > 0 ? <span className="invite__quota-used">· 已用 {used}</span> : null}
            </p>

            {remaining === 0 ? <p className="invite__hint">邀请名额已用完。</p> : null}

            {/* 有有效码：只给掩码（明文在库里不存在），只能在创建时看一次 */}
            {activeCode ? (
              <div className="invite__code">
                <div className="invite__code-head">
                  <span>当前邀请码</span>
                  <code className="invite__prefix">{maskedCode(activeCode.codePrefix)}</code>
                </div>
                <p className="invite__meta">
                  已用 {safeCount(activeCode.usedCount)} / {safeCount(activeCode.maxUses)} 次 ·{' '}
                  {expiryText(activeCode.expiresAt)}
                  {activeCode.note ? ` · 备注：${activeCode.note}` : ''}
                </p>
                <p className="invite__hint">
                  完整邀请码只在创建时显示一次，之后无法再查看；要发新的请先吊销（重新生成会自动吊销旧码未用部分）。
                </p>
                <div className="invite__actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => setConfirmRevoke(true)}
                    disabled={revoking}
                  >
                    吊销邀请码
                  </button>
                </div>
              </div>
            ) : null}

            {/* 创建成功：明文只在这里出现一次 */}
            {createdCode ? (
              <div className="token-box invite__plain">
                <p className="token-box__warn">⚠ 邀请码只显示这一次，刷新或离开页面后就查不到了。</p>
                <code className="token-box__value" ref={codeRef}>
                  {createdCode}
                </code>
                <div className="token-box__actions">
                  <button type="button" className="btn btn--primary" onClick={() => void copyCreatedCode()}>
                    复制邀请码
                  </button>
                </div>
              </div>
            ) : null}

            {!activeCode ? (
              <form
                className="invite__form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createInvite()
                }}
              >
                <div className="invite__row">
                  <label className="field">
                    <span className="field__label">本次邀请人数</span>
                    <input
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={Math.max(1, maxAllowed)}
                      step={1}
                      value={maxUsesValue}
                      onChange={(event) => setMaxUsesInput(event.target.value)}
                      disabled={creating || remaining === 0}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">备注（可选）</span>
                    <input
                      className="input"
                      type="text"
                      maxLength={40}
                      value={note}
                      placeholder="例如：给大学同学"
                      onChange={(event) => setNote(event.target.value)}
                      disabled={creating || remaining === 0}
                    />
                  </label>
                </div>
                <p className="field__hint">
                  一次生成一个邀请码，最多 {maxAllowed} 人可用，有效期 {ttlDays} 天；生成后可随时吊销。
                  名额只在被邀请的人真正注册后才扣减。
                </p>
                {formError ? (
                  <p className="invite__error" role="alert">
                    {formError}
                  </p>
                ) : null}
                <div className="invite__actions">
                  <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
                    {creating ? '正在生成…' : '生成邀请码'}
                  </button>
                </div>
              </form>
            ) : null}

            <div className="invite__section">
              <p className="invite__section-title">通过你的邀请加入（{invitees.length}）</p>
              {invitees.length === 0 ? (
                <p className="invite__hint">还没有人通过你的邀请加入</p>
              ) : (
                <ul className="invite__list">
                  {invitees.map((person, index) => (
                    <li className="invite__item" key={`${person.accountNo ?? person.displayName}-${index}`}>
                      <Avatar name={person.displayName} size="sm" />
                      <span className="invite__item-name">{person.displayName}</span>
                      {person.accountNo != null ? (
                        <span className="invite__item-no">{person.accountNo}</span>
                      ) : null}
                      <span className="invite__item-date">{formatDayLabel(person.joinedAt) || '—'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </section>

      {confirmRevoke && activeCode ? (
        <ConfirmDialog
          title="吊销邀请码"
          danger
          busy={revoking}
          confirmText="吊销"
          onCancel={() => setConfirmRevoke(false)}
          onConfirm={() => void revokeCode()}
        >
          <p>
            吊销后这个邀请码立即失效，还没用掉的次数作废（名额只在被邀请的人真正注册后才扣减，不会因吊销而增加）；
            已经通过它加入的朋友不受影响。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  )
}
