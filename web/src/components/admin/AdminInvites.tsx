import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../../api'
import type { AdminInvite, Notify } from '../../types'
import { cn, copyText, formatDayLabel, formatRelative } from '../../utils'
import { ConfirmDialog } from '../ConfirmDialog'

interface AdminInvitesProps {
  notify: Notify
}

/** 服务端只存哈希：列表里永远只有 4 位前缀，这里按产品约定渲染成掩码 */
function maskedCode(prefix: string): string {
  const value = (prefix || '').trim().toUpperCase()
  return value ? `AIO-${value}-****-****` : 'AIO-****-****-****'
}

type InviteState = 'valid' | 'revoked' | 'expired'

function inviteState(invite: AdminInvite): InviteState {
  if (invite.revokedAt) return 'revoked'
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) return 'expired'
  return 'valid'
}

const STATE_TEXT: Record<InviteState, string> = {
  valid: '有效',
  revoked: '已吊销',
  expired: '已过期',
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 站务「邀请」页：生成站务码（owner 为 NULL，不占任何人的名额）、看全站邀请码、吊销。
 *
 * 约束：
 * - 明文码只在 POST /api/admin/invites 的响应里出现一次，之后只剩 codePrefix；
 *   所以列表只能给掩码，「复制旧码」不存在。明文只留在组件 state 里，不写 storage。
 * - 后端 GET 只有 limit（1..200），没有 offset：一次拉 200 条，前端自己分页。
 * - 吊销走 ConfirmDialog，不用 window.confirm。
 */
export function AdminInvites({ notify }: AdminInvitesProps) {
  const [invites, setInvites] = useState<AdminInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [page, setPage] = useState(1)
  const [count, setCount] = useState('1')
  const [maxUses, setMaxUses] = useState('1')
  const [ttlDays, setTtlDays] = useState('7')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)
  /** 刚生成的明文码：只在这个 state 里，离开页面即消失 */
  const [createdCodes, setCreatedCodes] = useState<string[]>([])
  const [confirmInvite, setConfirmInvite] = useState<AdminInvite | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const list = await api.adminInvites(200)
        setInvites(list)
        setLoadError('')
      } catch (err) {
        if (err instanceof ApiError && err.code === 'unauthorized') return
        if (err instanceof ApiError && err.code === 'forbidden') {
          setLoadError('没有站务权限')
        } else if (!quiet) {
          setLoadError(err instanceof ApiError ? err.message : '邀请码加载失败，请重试')
        }
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  const countNum = Number(count)
  const maxNum = Number(maxUses)
  const ttlNum = Number(ttlDays)
  const formValid =
    Number.isInteger(countNum) &&
    countNum >= 1 &&
    countNum <= 20 &&
    Number.isInteger(maxNum) &&
    maxNum >= 1 &&
    maxNum <= 100 &&
    Number.isInteger(ttlNum) &&
    ttlNum >= 1 &&
    ttlNum <= 365

  const PAGE_SIZE = 20
  const pages = Math.max(1, Math.ceil(invites.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages)
  const pageItems = invites.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  async function createInvites() {
    if (creating) return
    if (!formValid) {
      setFormError('数量 1–20、单码人数 1–100、有效期 1–365 天（都要整数）')
      return
    }
    setCreating(true)
    setFormError('')
    try {
      const created = await api.createAdminInvites({
        count: countNum,
        maxUses: maxNum,
        expiresInDays: ttlNum,
        note: note.trim() || undefined,
      })
      const codes = created.map((item) => item.code).filter(Boolean)
      setCreatedCodes(codes)
      setNote('')
      notify(`已生成 ${codes.length} 个站务邀请码，明文只显示这一次`, 'success')
      setPage(1)
      await load(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      const message = err instanceof ApiError ? err.message : '生成邀请码失败，请重试'
      setFormError(message)
      notify(message, 'error')
    } finally {
      setCreating(false)
    }
  }

  async function copyAll() {
    if (createdCodes.length === 0) return
    const ok = await copyText(createdCodes.join('\n'))
    notify(ok ? '邀请码已复制（一行一个）' : '复制失败，请手动选中复制', ok ? 'success' : 'error')
  }

  async function revokeInvite() {
    if (!confirmInvite || revoking) return
    const target = confirmInvite
    setRevoking(true)
    try {
      await api.revokeAdminInvite(target.id)
      setConfirmInvite(null)
      setInvites((prev) =>
        prev.map((item) => (item.id === target.id ? { ...item, revokedAt: new Date().toISOString() } : item)),
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
      <div className="admin-invites">
        <p className="admin-invites__hint">
          站务邀请码不占用任何用户的名额；明文只在生成时显示一次，之后服务端只剩前缀，刷新后无法再查看。
        </p>

        <section className="admin-invites__card">
          <h2 className="admin-invites__title">生成站务码</h2>
          <div className="admin-invites__grid">
            <label className="field">
              <span className="field__label">数量（1–20）</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={20}
                value={count}
                data-testid="admin-invite-count"
                onChange={(event) => setCount(event.target.value)}
                disabled={creating}
              />
            </label>
            <label className="field">
              <span className="field__label">单码可用人数（1–100）</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                value={maxUses}
                data-testid="admin-invite-maxuses"
                onChange={(event) => setMaxUses(event.target.value)}
                disabled={creating}
              />
            </label>
            <label className="field">
              <span className="field__label">有效期（天，1–365）</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={ttlDays}
                data-testid="admin-invite-ttl"
                onChange={(event) => setTtlDays(event.target.value)}
                disabled={creating}
              />
            </label>
            <label className="field">
              <span className="field__label">备注（可选）</span>
              <input
                className="input"
                type="text"
                maxLength={40}
                value={note}
                placeholder="例如：2026-11 第一批"
                data-testid="admin-invite-note"
                onChange={(event) => setNote(event.target.value)}
                disabled={creating}
              />
            </label>
          </div>
          {formError ? (
            <p className="admin-invites__error" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="admin-invites__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="admin-invite-create"
              onClick={() => void createInvites()}
              disabled={creating || !formValid}
            >
              {creating ? '正在生成…' : '生成邀请码'}
            </button>
            <span className="field__hint">站务码可随时吊销；已兑换的人不受影响。</span>
          </div>

          {createdCodes.length > 0 ? (
            <div className="token-box admin-invites__plain">
              <p className="token-box__warn">⚠ 明文邀请码只显示这一次，刷新或离开页面后就查不到了。</p>
              <div className="admin-invites__codes" data-testid="admin-invite-codes">
                {createdCodes.map((code) => (
                  <code key={code} className="token-box__value admin-invites__code">
                    {code}
                  </code>
                ))}
              </div>
              <div className="token-box__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="admin-invite-copy-all"
                  onClick={() => void copyAll()}
                >
                  复制全部
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="admin-invites__card">
          <div className="admin-invites__head">
            <h2 className="admin-invites__title">邀请码（{invites.length}）</h2>
            <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
              刷新
            </button>
          </div>
          {invites.length >= 200 ? (
            <p className="admin-invites__hint">列表最多显示最近 200 张（接口单页上限）。</p>
          ) : null}

          {loading && invites.length === 0 ? <p className="admin__empty">正在加载…</p> : null}
          {!loading && loadError ? (
            <div className="admin-invites__actions">
              <p className="admin-invites__error" role="alert">
                {loadError}
              </p>
              <button type="button" className="btn btn--sm" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : null}
          {!loading && !loadError && invites.length === 0 ? <p className="admin__empty">还没有邀请码</p> : null}

          {invites.length > 0 ? (
            <ul className="admin-invites__list">
              {pageItems.map((invite) => {
                const state = inviteState(invite)
                return (
                  <li className="admin-invites__item" key={invite.id} data-invite-id={invite.id}>
                    <div className="admin-invites__item-head">
                      <code className="admin-invites__prefix" data-testid="admin-invite-prefix">
                        {maskedCode(invite.codePrefix)}
                      </code>
                      <span
                        className={cn('admin-invites__status', `admin-invites__status--${state}`)}
                        data-testid="admin-invite-status"
                      >
                        {STATE_TEXT[state]}
                      </span>
                    </div>
                    <div className="admin-invites__meta">
                      <span
                        className={cn(
                          'admin-invites__badge',
                          invite.owner ? 'admin-invites__badge--user' : 'admin-invites__badge--system',
                        )}
                      >
                        {invite.owner ? '用户码' : '站务码'}
                      </span>
                      <span>
                        {invite.owner
                          ? `${invite.owner.displayName}${invite.owner.accountNo != null ? ` #${invite.owner.accountNo}` : ''}`
                          : '站务创建'}
                      </span>
                      <span>
                        已用 {safeCount(invite.usedCount)} / {safeCount(invite.maxUses)}
                      </span>
                      <span>被邀请 {safeCount(invite.redemptions)} 人</span>
                      <span>{invite.expiresAt ? `${formatDayLabel(invite.expiresAt)}到期` : '长期有效'}</span>
                    </div>
                    {invite.note ? <p className="admin-invites__note">备注：{invite.note}</p> : null}
                    <div className="admin-invites__item-actions">
                      <span className="admin-invites__created">{formatRelative(invite.createdAt)}创建</span>
                      {!invite.revokedAt ? (
                        <button
                          type="button"
                          className="admin-card__btn admin-card__btn--danger"
                          data-testid="admin-invite-revoke"
                          onClick={() => setConfirmInvite(invite)}
                        >
                          吊销
                        </button>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}

          {pages > 1 ? (
            <div className="admin-invites__pager">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={currentPage <= 1}
              >
                上一页
              </button>
              <span className="admin-invites__pager-text">
                第 {currentPage} / {pages} 页
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPage((value) => Math.min(pages, value + 1))}
                disabled={currentPage >= pages}
              >
                下一页
              </button>
            </div>
          ) : null}
        </section>
      </div>

      {confirmInvite ? (
        <ConfirmDialog
          title="吊销邀请码"
          danger
          busy={revoking}
          confirmText="吊销"
          onCancel={() => setConfirmInvite(null)}
          onConfirm={() => void revokeInvite()}
        >
          <p>
            确认吊销 {maskedCode(confirmInvite.codePrefix)}？吊销后这张码立即失效，还没用掉的次数作废；
            已经兑换的人不受影响。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  )
}
