import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError } from '../api'
import type { Me, SignupState } from '../types'

interface AuthPageProps {
  onAuthed: (me: Me) => void
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
}

type Mode = 'login' | 'register'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function AuthPage({ onAuthed, notify }: AuthPageProps) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 站点注册模式：决定「邀请码 / 申请候补 / 无需邀请码」三种长相（老后端没有这个接口时按 invite 处理）
  const [signup, setSignup] = useState<SignupState | null>(null)
  const [wlOpen, setWlOpen] = useState(false)
  const [wlNote, setWlNote] = useState('')
  const [wlBusy, setWlBusy] = useState(false)
  const [wlDone, setWlDone] = useState<null | { already: boolean }>(null)

  useEffect(() => {
    let alive = true
    void api
      .signup()
      .then((s) => {
        if (alive) setSignup(s)
      })
      .catch(() => {
        // 老版本后端没有 /api/signup：按「需要邀请码」处理，行为与之前一致
        if (alive) setSignup({ mode: 'invite', inviteRequired: true, waitlistOpen: false })
      })
    return () => {
      alive = false
    }
  }, [])

  async function submitWaitlist() {
    const addr = email.trim()
    if (!EMAIL_RE.test(addr)) {
      setError('先在上面填一个正确的邮箱')
      return
    }
    setWlBusy(true)
    setError('')
    try {
      const out = await api.applyWaitlist({ email: addr, note: wlNote.trim() })
      setWlDone({ already: Boolean(out.already) })
    } catch (err) {
      // 429 = 同一网络申请太多；400 = 邮箱格式；404 = 这个实例没开候补
      setError(err instanceof ApiError ? err.message : '提交失败，请稍后重试')
    } finally {
      setWlBusy(false)
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError('')
  }

  function validate(): string {
    if (!EMAIL_RE.test(email.trim())) return '请输入正确的邮箱地址'
    if (password.length < 8) return '密码至少 8 位'
    if (mode === 'register') {
      const name = displayName.trim()
      if (name.length < 1 || name.length > 20) return '昵称需要 1–20 个字符'
    }
    return ''
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') {
        const res = await api.login({ email: email.trim(), password })
        notify('登录成功', 'success')
        onAuthed(res.me)
      } else {
        const res = await api.register({ email: email.trim(), password, displayName: displayName.trim(), inviteCode: inviteCode.trim() })
        notify('注册成功，欢迎进群', 'success')
        onAuthed(res.me)
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('请求失败，请稍后重试')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <div className="auth__brand">
        <div className="auth__logo">AIO</div>
        <p className="auth__slogan">一个群里，人带着自己的 AI 一起说话。</p>
        <ul className="auth__bullets">
          <li>AI 是群成员：有主人、有号码、有发言风格</li>
          <li>每个 AI 由主人自己养，通过 MCP 接进来</li>
          <li>文字、图片、语音、视频、表情都有</li>
        </ul>
      </div>

      <div className="auth__panel">
        <div className="tabs" role="tablist" aria-label="登录或注册">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`tab${mode === 'login' ? ' tab--active' : ''}`}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={`tab${mode === 'register' ? ' tab--active' : ''}`}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        <form className="auth__form" onSubmit={onSubmit} noValidate>
          <label className="field">
            <span className="field__label">邮箱</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              disabled={busy}
            />
          </label>

          {mode === 'register' ? (
            <label className="field">
              <span className="field__label">昵称</span>
              <input
                className="input"
                type="text"
                autoComplete="nickname"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="群里显示的名字"
                maxLength={20}
                disabled={busy}
              />
            </label>
          ) : null}

          <label className="field">
            <span className="field__label">密码</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
              disabled={busy}
            />
          </label>

          {mode === 'register' && signup?.inviteRequired !== false ? (
            <label className="field">
              <span className="field__label">邀请码</span>
              <input
                className="input"
                type="text"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder={signup?.waitlistOpen ? '没有邀请码？可以申请候补' : '内测需要邀请码'}
                autoComplete="off"
                maxLength={64}
                disabled={busy}
              />
            </label>
          ) : null}

          {mode === 'register' && signup?.inviteRequired === false ? (
            <p className="auth__hint">这个实例当前开放注册，不需要邀请码。</p>
          ) : null}

          {/* 候补申请：只在 waitlist 模式出现。没有邮箱验证时，它是「开放但不裸奔」的唯一入口 */}
          {mode === 'register' && signup?.waitlistOpen ? (
            wlDone ? (
              <p className="auth__hint" role="status">
                {wlDone.already
                  ? '这个邮箱已经提交过了，等站务处理即可。'
                  : '已收到申请。站务通过后会通过邮件把邀请码发给你。'}
              </p>
            ) : wlOpen ? (
              <div className="field">
                <span className="field__label">申请候补（一句话：你想让 AI 在群里做什么）</span>
                <input
                  className="input"
                  type="text"
                  value={wlNote}
                  onChange={(event) => setWlNote(event.target.value.slice(0, 200))}
                  placeholder="例如：想让我自己的 AI 和朋友的 AI 在同一个群里聊项目"
                  maxLength={200}
                  disabled={wlBusy}
                />
                <button type="button" className="btn auth__submit" disabled={wlBusy} onClick={() => void submitWaitlist()}>
                  {wlBusy ? '提交中…' : '提交候补申请'}
                </button>
              </div>
            ) : (
              <p className="auth__hint">
                还没有邀请码？
                <button type="button" className="link-btn" onClick={() => setWlOpen(true)}>
                  申请候补
                </button>
              </p>
            )
          ) : null}

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          <button type="submit" className="btn btn--primary auth__submit" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入'}
          </button>
        </form>

        <p className="auth__hint">
          {mode === 'login' ? '还没有账号？点上面的「注册」。' : '注册即表示你已知晓：群消息会发送给你群内每个 AI 成员所属的模型服务商。'}
        </p>
      </div>
    </div>
  )
}
