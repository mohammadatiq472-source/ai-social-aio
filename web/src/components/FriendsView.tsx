import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { Friend, FriendRequest } from '../types'
import { Avatar } from './Avatar'

type Notify = (text: string, kind?: 'info' | 'success' | 'error') => void

interface FriendsViewProps {
  notify: Notify
  /** 作为「我的」二级页时显示返回；作为底部 Tab 时不传 */
  onBack?: () => void
}

const ACCOUNT_RE = /^\d{4,12}$/

/** 好友：列表 + 待处理请求 + 按号码加好友 */
export function FriendsView({ notify, onBack }: FriendsViewProps) {
  const [friends, setFriends] = useState<Friend[]>([])
  const [requests, setRequests] = useState<FriendRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.friends()
      setFriends(Array.isArray(data.friends) ? data.friends : [])
      setRequests(Array.isArray(data.requests) ? data.requests : [])
      setHasMore(Boolean(data.has_more))
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '好友列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /** 好友很多时不要一次渲染完：按 offset 追加 */
  async function loadMoreFriends() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const data = await api.friends(friends.length, 200)
      setFriends((prev) => [...prev, ...(Array.isArray(data.friends) ? data.friends : [])])
      setHasMore(Boolean(data.has_more))
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '加载更多好友失败', 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  /** 人类发起私聊：已有会话就复用；成功后会话列表里会出现（列表定时刷新/重连也会补） */
  async function openDmWith(friend: { id: number; displayName: string }) {
    setBusy(`dm-${friend.id}`)
    try {
      await api.openDm(friend.id)
      // 让聊天页重新拉一次会话列表，否则刚建的私聊要等刷新才出现
      window.dispatchEvent(new CustomEvent('aio:refresh-conversations'))
      notify(`已打开与「${friend.displayName}」的会话，去聊天列表里看`, 'success')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '打开私聊失败', 'error')
    } finally {
      setBusy('')
    }
  }

  async function submitAccount() {
    const value = account.trim()
    if (!ACCOUNT_RE.test(value)) {
      notify('请输入 8 位账号号', 'error')
      return
    }
    setBusy('add')
    try {
      await api.requestFriend(Number(value))
      setAccount('')
      notify('已发送请求，等对方同意', 'success')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '发送失败，请重试', 'error')
    } finally {
      setBusy('')
    }
  }

  async function accept(request: FriendRequest) {
    setBusy(`accept-${request.id}`)
    try {
      await api.acceptFriend(request.id)
      notify('已加为好友', 'success')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败，请重试', 'error')
    } finally {
      setBusy('')
    }
  }

  async function reject(request: FriendRequest) {
    setBusy(`reject-${request.id}`)
    try {
      await api.removeFriend(request.id)
      notify('已忽略这个请求', 'info')
      await load()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '操作失败，请重试', 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="friends">
      <header className="friends__head">
        {onBack ? (
          <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
            ←
          </button>
        ) : (
          <span className="friends__head-spacer" />
        )}
        <h1 className="friends__title">好友</h1>
        <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={busy !== ''}>
          刷新
        </button>
      </header>

      <div className="friends__body">
        <section className="friends__add">
          <input
            className="input"
            inputMode="numeric"
            value={account}
            maxLength={12}
            placeholder="输入 8 位账号号"
            aria-label="账号号"
            onChange={(event) => setAccount(event.target.value.replace(/\D/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submitAccount()
              }
            }}
          />
          <button type="button" className="btn btn--primary" disabled={busy !== '' || account.trim() === ''} onClick={() => void submitAccount()}>
            加好友
          </button>
        </section>

        {loading ? <p className="friends__state">正在加载…</p> : null}
        {!loading && error ? <p className="friends__state">{error}</p> : null}

        {requests.length > 0 ? (
          <section className="friends__section">
            <h2 className="friends__section-title">新的朋友 {requests.length}</h2>
            <ul className="friends__list">
              {requests.map((request) => (
                <li key={request.id} className="friend-row">
                  <Avatar name={request.displayName} hue={(request.id * 43) % 360} type="user" size="sm" url={request.avatarUrl} />
                  <span className="friend-row__main">
                    <span className="friend-row__name">{request.displayName}</span>
                    <span className="friend-row__meta">{request.accountNo ?? ''}</span>
                  </span>
                  <span className="friend-row__actions">
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={busy !== ''}
                      onClick={() => void accept(request)}
                    >
                      同意
                    </button>
                    <button type="button" className="btn btn--sm" disabled={busy !== ''} onClick={() => void reject(request)}>
                      拒绝
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="friends__section">
          <h2 className="friends__section-title">我的好友 {friends.length}</h2>
          {!loading && friends.length === 0 ? (
            <div className="friends__empty">
              <p>还没有好友</p>
              <p className="friends__empty-hint">把对方的 8 位账号号填到上面，等对方同意。</p>
            </div>
          ) : (
            <ul className="friends__list">
              {friends.map((friend) => (
                <li key={friend.id} className="friend-row">
                  <Avatar name={friend.displayName} hue={(friend.id * 43) % 360} type={friend.type} size="sm" url={friend.avatarUrl} />
                  <span className="friend-row__main">
                    <span className="friend-row__name">
                      {friend.displayName}
                      {friend.type === 'agent' ? <span className="ai-badge">AI</span> : null}
                    </span>
                    <span className="friend-row__meta">{friend.accountNo ?? ''}</span>
                  </span>
                  <span className="friend-row__actions">
                    <button type="button" className="btn btn--sm" disabled={busy !== ''} onClick={() => void openDmWith(friend)}>
                      私聊
                    </button>
                  </span>
                </li>
              ))}
              {hasMore ? (
                <li className="friends__more">
                  <button type="button" className="btn btn--sm" disabled={loadingMore} onClick={() => void loadMoreFriends()}>
                    {loadingMore ? '加载中…' : '加载更多好友'}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
