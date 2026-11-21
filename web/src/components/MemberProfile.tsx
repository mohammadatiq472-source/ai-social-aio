import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type { Me, PrincipalProfile } from '../types'
import { copyText, formatRelative } from '../utils'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { Avatar } from './Avatar'

type Notify = (text: string, kind?: 'info' | 'success' | 'error') => void

interface MemberProfileProps {
  principalId: number
  me: Me
  notify: Notify
  onClose: () => void
  onOpenConversation: (conversationId: number, seq?: number | null) => void
}

/**
 * 成员主页：人和 AI 长得一模一样 —— 头像/名字/号码 + TA 的群聊 + TA 最近说的话，
 * 底部只有两个动作：发消息 + 加好友/已是好友。AI 只多一个角标和「由 XX 创建」。
 */
export function MemberProfile({ principalId, me, notify, onClose, onOpenConversation }: MemberProfileProps) {
  const [profile, setProfile] = useState<PrincipalProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setProfile(await api.principalProfile(principalId))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '主页加载失败')
    } finally {
      setLoading(false)
    }
  }, [principalId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function addFriend() {
    if (profile?.accountNo == null) return
    setBusy('friend')
    try {
      await api.requestFriend(profile.accountNo)
      notify('已发送请求，等对方同意', 'success')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '请求失败，请重试', 'error')
    } finally {
      setBusy('')
    }
  }

  async function acceptFriend() {
    if (!profile) return
    setBusy('friend')
    try {
      await api.acceptFriend(profile.id)
      notify('已加为好友', 'success')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败，请重试', 'error')
    } finally {
      setBusy('')
    }
  }

  async function removeFriend() {
    if (!profile) return
    setBusy('friend')
    try {
      await api.removeFriend(profile.id)
      notify('已删除好友', 'info')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败，请重试', 'error')
    } finally {
      setBusy('')
    }
  }

  async function copyAccountNo() {
    if (profile?.accountNo == null) return
    const ok = await copyText(String(profile.accountNo))
    notify(ok ? '号码已复制' : '复制失败，请手动选择复制', ok ? 'success' : 'error')
  }

  const isSelf = profile?.id === me.id
  const friendStatus = profile?.friendStatus ?? 'none'
  const latestConversation = profile?.conversations?.[0] ?? null

  return (
    <div ref={panelRef} className="profile" role="dialog" aria-modal="true" aria-label="成员主页" tabIndex={-1}>
      <header className="profile__head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="返回">
          ←
        </button>
        <span className="profile__head-title">主页</span>
        <span className="profile__head-spacer" />
      </header>

      <div className="profile__body">
        {loading ? <p className="profile__state">正在加载…</p> : null}
        {!loading && error ? (
          <div className="profile__state">
            <p>{error}</p>
            <button type="button" className="btn btn--sm" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}

        {profile ? (
          <>
            <section className="profile__hero">
              <Avatar name={profile.displayName} hue={(profile.id * 43) % 360} type={profile.type} size="lg" url={profile.avatarUrl} />
              <div className="profile__hero-main">
                <p className="profile__name">
                  {profile.displayName}
                </p>
                {profile.accountNo != null ? (
                  <div className="profile__account">
                    <span className="profile__account-no">{profile.accountNo}</span>
                    <button type="button" className="btn btn--sm" onClick={() => void copyAccountNo()}>
                      复制
                    </button>
                  </div>
                ) : null}
                {profile.isAgent && profile.ownerName ? <p className="profile__owner">由 {profile.ownerName} 创建</p> : null}
              </div>
            </section>

            {!isSelf ? (
              <div className="profile__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!latestConversation}
                  onClick={() => latestConversation && onOpenConversation(latestConversation.id)}
                >
                  发消息
                </button>
                {friendStatus === 'friend' ? (
                  <>
                    <span className="profile__hint">已是好友</span>
                    <button type="button" className="btn" disabled={busy !== ''} onClick={() => void removeFriend()}>
                      删除好友
                    </button>
                  </>
                ) : friendStatus === 'pending' ? (
                  <span className="profile__hint">已发送请求，等待同意</span>
                ) : friendStatus === 'incoming' ? (
                  <button type="button" className="btn" disabled={busy !== ''} onClick={() => void acceptFriend()}>
                    同意好友请求
                  </button>
                ) : (
                  <button type="button" className="btn" disabled={busy !== '' || profile.accountNo == null} onClick={() => void addFriend()}>
                    加好友
                  </button>
                )}
              </div>
            ) : null}

            <section className="profile__section">
              <h2 className="profile__section-title">TA 的群聊</h2>
              {profile.conversations.length === 0 ? (
                <p className="profile__empty">还没有共同群聊</p>
              ) : (
                <ul className="profile__conv-list">
                  {profile.conversations.map((conv) => (
                    <li key={conv.id}>
                      <button type="button" className="profile-conv" onClick={() => onOpenConversation(conv.id)}>
                        <Avatar name={conv.title || '群'} hue={(conv.id * 31) % 360} type="user" size="sm" />
                        <span className="profile-conv__main">
                          <span className="profile-conv__title">{conv.title || '未命名群'}</span>
                          <span className="profile-conv__time">{conv.lastAt ? formatRelative(conv.lastAt) : ''}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="profile__section">
              <h2 className="profile__section-title">TA 最近说的话</h2>
              {profile.recentMessages.length === 0 ? (
                <p className="profile__empty">最近还没有发言</p>
              ) : (
                <ul className="profile__msg-list">
                  {profile.recentMessages.map((msg) => (
                    <li key={`${msg.conversationId}-${msg.seq}`}>
                      <button type="button" className="profile-msg" onClick={() => onOpenConversation(msg.conversationId, msg.seq)}>
                        <span className="profile-msg__group">{msg.title || '群聊'}</span>
                        <span className="profile-msg__bubble">{msg.body || '[非文本消息]'}</span>
                        <span className="profile-msg__time">{formatRelative(msg.createdAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
}
